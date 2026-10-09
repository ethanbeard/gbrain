import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deferralEligible, performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { readGitHoldRetryPaths, readSyncDeferrals, recordSyncDeferral, SYNC_DEFERRALS_OP } from '../src/core/persistence/sync-holds.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { deferralExitCode } from '../src/commands/sync/run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'change') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const setup = ({ root }: { root: string }) => { git(root, 'init', '-q'); for (const p of ['a.md', 'm.md', 'z.md']) writeFileSync(join(root, p), `Original ${p}.\n`); commit(root, 'initial'); };
const receipt = (message: string, code = 'source_changed') => ({ error_code: code, error_message: message });
const pending = (kind: 'managed_sync_import' | 'managed_sync_delete' | 'managed_sync_checkpoint' = 'managed_sync_import', path: string | null = 'm.md', renameFrom?: object) =>
  ({ intent: { kind, path, ...(renameFrom ? { renameFrom } : {}) } } as any);
const entry = (path = 'm.md', action: 'import' | 'delete' = 'import', renameFrom?: any) => ({ path, sourcePath: path, action, working: false, ...(renameFrom ? { renameFrom } : {}) });

describe('source_changed deferral eligibility', () => {
  const good = { receipt: receipt('The imported file changed after sync admission.'), pending: pending(), entry: entry(), entries: [entry()] };
  test('accepts exactly the two source_changed reasons', () => {
    expect(deferralEligible(good)).toEqual({ reason: 'raw_file_changed' });
    expect(deferralEligible({ ...good, receipt: receipt('Newer working-tree bytes and the current page disagree with this pinned Git import.') })).toEqual({ reason: 'pinned_git_worktree_conflict' });
  });
  test.each([
    ['error code', { ...good, receipt: receipt('The imported file changed after sync admission.', 'storage_error') }],
    ['reason', { ...good, receipt: receipt('The canonical file was removed outside coordinated publication.') }],
    ['checkpoint', { ...good, pending: pending('managed_sync_checkpoint', 'm.md') }],
    ['path', { ...good, pending: pending('managed_sync_import', 'other.md') }],
    ['company', { ...good, company: true }],
    ['pending rename', { ...good, pending: pending('managed_sync_import', 'm.md', { sourcePath: 'old.md' }) }],
    ['entry rename', { ...good, entry: entry('m.md', 'import', { sourcePath: 'old.md' }) }],
    ['rename delete side', { ...good, pending: pending('managed_sync_delete'), entry: entry('m.md', 'delete'), entries: [entry('m.md', 'delete'), entry('new.md', 'import', { sourcePath: 'm.md' })] }],
  ] as const)('rejects %s alone', (_name, input) => expect(deferralEligible(input as any)).toBeNull());
});

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`managed source_changed deferral (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('raw file change skips the middle entry, continues, re-queues, then resolves after commit', () => managedBrain(async ({ engine, root }) => {
    const opts = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, noBulk: true };
    await performManagedSync(engine, opts);
    for (const p of ['a.md', 'm.md', 'z.md']) writeFileSync(join(root, p), `Committed ${p}.\n`);
    const head = commit(root);
    let fired = false;
    installFaultHook(async (point) => {
      if (point !== 'sync:mid_checkpoint' || fired) return;
      const [row] = await engine.executeRaw<{ path: string | null }>("SELECT completed_keys->0->'pending'->'intent'->>'path' AS path FROM op_checkpoints WHERE op='managed-sync'");
      if (row?.path !== 'm.md') return;
      fired = true; writeFileSync(join(root, 'm.md'), 'Rewritten while admitted.\n');
    });
    let first;
    try { first = await performManagedSync(engine, opts); } finally { installFaultHook(undefined); }
    expect(fired).toBe(true);
    expect(first).toMatchObject({ status: 'synced', toCommit: head, deferred: [{ path: 'm.md', reason: 'raw_file_changed' }] });
    expect((await engine.getPage('a', { sourceId: 'default' }))?.compiled_truth).toContain('Committed a.md');
    expect((await engine.getPage('m', { sourceId: 'default' }))?.compiled_truth).toContain('Original m.md');
    expect((await engine.getPage('z', { sourceId: 'default' }))?.compiled_truth).toContain('Committed z.md');
    const incarnation = (await getWorktreeBinding(engine, 'default'))!.source_incarnation;
    expect(await readGitHoldRetryPaths(engine, 'default', incarnation)).toEqual(['m.md']);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure'")).toEqual([]);
    expect(deferralExitCode(first)).toBe(0);
    const next = commit(root, 'settled rewrite');
    const resolved = await performManagedSync(engine, opts);
    expect(resolved).toMatchObject({ status: 'synced', toCommit: next });
    expect(resolved.deferred).toBeUndefined();
    expect((await engine.getPage('m', { sourceId: 'default' }))?.compiled_truth).toContain('Rewritten while admitted');
    expect(await readGitHoldRetryPaths(engine, 'default', incarnation)).toEqual([]);
    expect(await readSyncDeferrals(engine, 'default', incarnation)).toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('an uncommitted pinned conflict persists for three runs, deduplicates a run, and resets after resolution', () => managedBrain(async ({ engine, root }) => {
    const opts = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, noBulk: true };
    await performManagedSync(engine, opts);
    writeFileSync(join(root, 'm.md'), 'Committed update.\n'); commit(root);
    writeFileSync(join(root, 'm.md'), 'Divergent working bytes.\n');
    const incarnation = (await getWorktreeBinding(engine, 'default'))!.source_incarnation;
    for (let run = 1; run <= 3; run++) {
      const result = await performManagedSync(engine, opts);
      expect(result).toMatchObject({ status: 'synced', deferred: [{ path: 'm.md', reason: 'pinned_git_worktree_conflict' }] });
      expect(deferralExitCode(result)).toBe(run === 3 ? 1 : 0);
    }
    const history = (await readSyncDeferrals(engine, 'default', incarnation))!;
    expect(history.paths['m.md']?.runs).toBe(3);
    await engine.transaction(async tx => {
      await recordSyncDeferral(tx, 'default', incarnation, { path: 'same.md', reason: 'raw_file_changed', run_id: 'same-run' });
      await recordSyncDeferral(tx, 'default', incarnation, { path: 'same.md', reason: 'raw_file_changed', run_id: 'same-run' });
    });
    expect((await readSyncDeferrals(engine, 'default', incarnation))!.paths['same.md']?.runs).toBe(1);
    commit(root, 'resolve working bytes');
    expect((await performManagedSync(engine, opts)).deferred).toBeUndefined();
    expect((await readSyncDeferrals(engine, 'default', incarnation))?.paths['m.md']).toBeUndefined();
  }, { databaseUrl, setup }), 120_000);

  test('non-eligible broken frontmatter still blocks', () => managedBrain(async ({ engine, root }) => {
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(join(root, 'm.md'), '---\ntitle: [broken\n---\n'); commit(root);
    const result = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
    expect(result).toMatchObject({ status: 'blocked_by_failures' });
    expect(result.deferred).toBeUndefined();
  }, { databaseUrl, setup }), 120_000);

  test('a divergent rename remains blocking and preserves the original page identity', () => managedBrain(async ({ engine, root }) => {
    const opts = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, noBulk: true };
    const original = Array.from({ length: 40 }, (_, i) => `Stable rename line ${i}.`).join('\n') + '\n';
    writeFileSync(join(root, 'm.md'), original); commit(root, 'rename baseline');
    await performManagedSync(engine, opts);
    const before = await engine.readPageSnapshot('m', { sourceId: 'default' });
    git(root, 'mv', 'm.md', 'new.md');
    writeFileSync(join(root, 'new.md'), original + 'Committed renamed content.\n'); commit(root, 'rename');
    writeFileSync(join(root, 'new.md'), original + 'Divergent renamed content.\n');
    const result = await performManagedSync(engine, opts);
    expect(result).toMatchObject({ status: 'blocked_by_failures' });
    expect(result.deferred).toBeUndefined();
    const incarnation = (await getWorktreeBinding(engine, 'default'))!.source_incarnation;
    expect(await readGitHoldRetryPaths(engine, 'default', incarnation)).toEqual([]);
    expect((await engine.readPageSnapshot('m', { sourceId: 'default' }))?.page.id).toBe(before?.page.id);
  }, { databaseUrl, setup }), 120_000);

  test('a legacy blocked source_changed cursor defers on plain rerun and --retry-failed without rediscovery', () => managedBrain(async ({ engine, root }) => {
    const opts = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, noBulk: true };
    await performManagedSync(engine, opts);
    writeFileSync(join(root, 'm.md'), 'Committed update.\n'); commit(root);
    process.env.GBRAIN_TEST_DISABLE_SOURCE_CHANGED_DEFERRAL = '1';
    let fired = false;
    installFaultHook(async point => {
      if (point !== 'sync:mid_checkpoint' || fired) return;
      const [row] = await engine.executeRaw<{ path: string | null }>("SELECT completed_keys->0->'pending'->'intent'->>'path' AS path FROM op_checkpoints WHERE op='managed-sync'");
      if (row?.path === 'm.md') { fired = true; writeFileSync(join(root, 'm.md'), 'Changed after admission.\n'); }
    });
    let blocked;
    try { blocked = await performManagedSync(engine, opts); } finally { installFaultHook(undefined); delete process.env.GBRAIN_TEST_DISABLE_SOURCE_CHANGED_DEFERRAL; }
    expect(blocked.status).toBe('blocked_by_failures');
    const runId = blocked.runId;
    const replay = await performManagedSync(engine, opts);
    expect(replay).toMatchObject({ status: 'synced', runId, deferred: [expect.objectContaining({ path: expect.any(String) })] });

    writeFileSync(join(root, 'm.md'), 'Another committed update.\n'); commit(root);
    process.env.GBRAIN_TEST_DISABLE_SOURCE_CHANGED_DEFERRAL = '1';
    fired = false;
    installFaultHook(async point => {
      if (point !== 'sync:mid_checkpoint' || fired) return;
      const [row] = await engine.executeRaw<{ path: string | null }>("SELECT completed_keys->0->'pending'->'intent'->>'path' AS path FROM op_checkpoints WHERE op='managed-sync'");
      if (row?.path === 'm.md') { fired = true; writeFileSync(join(root, 'm.md'), 'Another post-admission change.\n'); }
    });
    try { blocked = await performManagedSync(engine, opts); } finally { installFaultHook(undefined); delete process.env.GBRAIN_TEST_DISABLE_SOURCE_CHANGED_DEFERRAL; }
    const retryRunId = blocked.runId;
    const retried = await performManagedSync(engine, { ...opts, retryFailed: true });
    expect(retried).toMatchObject({ status: 'synced', runId: retryRunId, deferred: [expect.objectContaining({ path: 'm.md' })] });
  }, { databaseUrl, setup }), 120_000);

  test('stale deferral checkpoints survive purge only while their source incarnation is current', () => managedBrain(async ({ engine }) => {
    const incarnation = (await getWorktreeBinding(engine, 'default'))!.source_incarnation;
    await recordSyncDeferral(engine, 'default', incarnation, { path: 'm.md', reason: 'raw_file_changed', run_id: 'r1' });
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days' WHERE op=$1", [SYNC_DEFERRALS_OP]);
    await purgeStaleCheckpoints(engine, 7);
    expect(await readSyncDeferrals(engine, 'default', incarnation)).not.toBeNull();
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,incarnation}',to_jsonb('stale'::text)),updated_at=now()-interval '30 days' WHERE op=$1", [SYNC_DEFERRALS_OP]);
    await purgeStaleCheckpoints(engine, 7);
    expect(await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1', [SYNC_DEFERRALS_OP])).toEqual([]);
  }, { databaseUrl, setup }), 120_000);
});
