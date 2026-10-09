import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { SCREENING_REQUEST_ID, screeningRequest } from '../src/core/persistence/noop-kernel.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-replay-waive-'));
const env = {
  GBRAIN_HOME: home,
  GBRAIN_SYNC_FAILURES_DIR: home,
  GBRAIN_SOURCE: undefined,
  OPENAI_API_KEY: undefined,
  VOYAGE_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};
let engine: BrainEngine;

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = (root: string) => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
};
const note = (i: number, suffix = 'for the replay') => `---\ntitle: N${i}\n---\nObservation ${i} ${suffix}.\n`;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engine = lite;
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(count: number) {
  const id = `s-${randomUUID().slice(0, 12)}`;
  const root = join(home, id);
  mkdirSync(root);
  git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, `n${String(i).padStart(2, '0')}.md`), note(i));
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base: SyncOpts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] };
  return { id, root, base };
}

async function recordKilledRun(id: string) {
  const [cursor] = await engine.executeRaw<{ fingerprint: string; run_id: string }>(
    "SELECT fingerprint,completed_keys->0->>'runId' AS run_id FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
  expect(cursor).toBeDefined();
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync-failure',$1,$2::text::jsonb) ON CONFLICT DO NOTHING",
    [cursor!.fingerprint, JSON.stringify([{ run_id: cursor!.run_id }])]);
}

function countTransactions(target: BrainEngine): { engine: BrainEngine; count: () => number } {
  let count = 0;
  return { count: () => count, engine: new Proxy(target, { get(value, key) {
    if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => { count++; return value.transaction(fn); };
    const member = Reflect.get(value, key);
    return typeof member === 'function' ? member.bind(value) : member;
  } }) };
}

async function replayWithCount(batch: '0' | '1', screenUnadmitted = '1') {
  return withEnv({ ...env, GBRAIN_SYNC_WAIVE_BATCH: batch, GBRAIN_SYNC_SCREEN_UNADMITTED: screenUnadmitted }, async () => {
    const f = await fixture(12);
    expect(await performManagedSync(engine, f.base, { maxPages: 10, maxMs: 60_000 })).toMatchObject({ status: 'partial', filesImported: 10 });
    writeFileSync(join(f.root, 'zz-new.md'), '---\ntitle: New\n---\nA new page between runs.\n');
    commit(f.root);
    await recordKilledRun(f.id);
    await disposePersistenceConsumer(engine);
    const counted = countTransactions(engine);
    let result: Awaited<ReturnType<typeof performManagedSync>>;
    try {
      result = await performManagedSync(counted.engine, { ...f.base, retryFailed: true });
    } finally {
      await disposePersistenceConsumer(counted.engine);
    }
    return { f, result: result!, transactions: counted.count() };
  });
}

const retryImports = (id: string, runId: string) => engine.executeRaw<{ slug: string; status: string }>(
  "SELECT slug,outcome->>'status' AS status FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' AND intent->>'runId'=$2 ORDER BY sequence", [id, runId]);

test('T1 batches replayed imports without admitting the unchanged prefix', async () => {
  const batched = await replayWithCount('1');
  const individual = await replayWithCount('0');
  expect(batched.result.waived).toEqual({ imports: 10, deletes: 0 });
  expect((await retryImports(batched.f.id, batched.result.runId!))
    .filter(row => /^n0\d$/.test(row.slug))).toEqual([]);
  expect(batched.transactions).toBeLessThan(individual.transactions / 2);
}, 240_000);

test('T2 a replayed bulk follower is waived instead of grouped and published as skipped', async () => withEnv(env, async () => {
  const f = await fixture(10);
  await performManagedSync(engine, f.base, { maxPages: 6, maxMs: 60_000 });
  writeFileSync(join(f.root, 'n00.md'), note(0, 'edited between runs'));
  writeFileSync(join(f.root, 'zz-new.md'), '---\ntitle: New\n---\nA new page between runs.\n');
  commit(f.root);
  await recordKilledRun(f.id);
  const result = await performManagedSync(engine, { ...f.base, retryFailed: true,
    bulk: { enabled: true, reason: null, size: 4, maxTxnMs: 15_000, maxTxnExplicit: false } });
  const requests = await retryImports(f.id, result.runId!);
  expect(result.waived).toEqual({ imports: 5, deletes: 0 });
  expect(requests.filter(row => row.status === 'skipped')).toEqual([]);
  expect(requests).toContainEqual({ slug: 'n00', status: 'updated' });
}), 180_000);

test('T3 changed content is admitted and stops the no-op waiver prefix', async () => withEnv(env, async () => {
  const f = await fixture(12);
  await performManagedSync(engine, f.base, { maxPages: 10, maxMs: 60_000 });
  writeFileSync(join(f.root, 'n03.md'), note(3, 'edited between runs'));
  writeFileSync(join(f.root, 'zz-new.md'), '---\ntitle: New\n---\nA new page between runs.\n');
  commit(f.root);
  await recordKilledRun(f.id);
  const result = await performManagedSync(engine, { ...f.base, retryFailed: true });
  const requests = await retryImports(f.id, result.runId!);
  expect(result.waived).toEqual({ imports: 9, deletes: 0 });
  expect(requests.filter(row => ['n00', 'n01', 'n02'].includes(row.slug))).toEqual([]);
  expect(requests).toContainEqual({ slug: 'n03', status: 'updated' });
}), 180_000);

test('T4 GBRAIN_SYNC_SCREEN_UNADMITTED=0 restores per-entry waiver behavior', async () => {
  const batched = await replayWithCount('1', '0');
  const individual = await replayWithCount('0', '0');
  expect(batched.result.waived).toEqual({ imports: 10, deletes: 0 });
  expect(individual.result.waived).toEqual({ imports: 10, deletes: 0 });
  expect(batched.transactions).toBe(individual.transactions);
}, 240_000);

test('T5 screening keeps the run fence and ordinary requests keep the membership fence', async () => withEnv(env, async () => {
  const f = await fixture(3);
  await performManagedSync(engine, f.base);
  for (let i = 0; i < 3; i++) writeFileSync(join(f.root, `n0${i}.md`), note(i, 'revised for the cursor fence'));
  commit(f.root);
  await performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 });
  const [row] = await engine.executeRaw<WriteRequest>(
    "SELECT r.* FROM persistence_requests r JOIN op_checkpoints c ON c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1 AND r.intent->>'runId'=c.completed_keys->0->>'runId' WHERE r.source_id=$1 AND r.intent->>'kind'='managed_sync_import' ORDER BY r.sequence DESC LIMIT 1", [f.id]);
  expect(row).toBeDefined();
  const snapshot = await engine.readPageSnapshot(row!.slug, { sourceId: f.id });
  expect(snapshot).not.toBeNull();
  const currentIntent = { ...(row!.intent as SyncIntent), expected_revision: snapshot!.revision };
  const fields = {
    source_id: row!.source_id, source_incarnation: row!.source_incarnation, slug: row!.slug, page_id: snapshot!.page.id,
    worktree_id: row!.worktree_id, authority: row!.authority, request_id: randomUUID(),
  };
  const staleRun = screeningRequest({ ...fields, intent: { ...currentIntent, runId: randomUUID() } });
  expect(staleRun.id).toBe(SCREENING_REQUEST_ID);
  const stalePrepared = await prepareManagedSyncMutation(engine, staleRun, { engine: engine.kind } as GBrainConfig);
  await expect(stalePrepared.validate!(engine)).rejects.toMatchObject({ code: 'revision_conflict' });

  const ordinary = { ...screeningRequest({ ...fields, intent: currentIntent }), id: randomUUID(), request_id: randomUUID() };
  const ordinaryPrepared = await prepareManagedSyncMutation(engine, ordinary, { engine: engine.kind } as GBrainConfig);
  await expect(ordinaryPrepared.validate!(engine)).rejects.toMatchObject({ code: 'revision_conflict' });
}), 120_000);
