/** Persisted claim progress distinguishes a renewing stall from real group preparation progress. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { executeClaimedGroup } from '../src/core/persistence/group-publish.ts';
import { hasClaimableWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import * as drain from '../src/core/persistence/sync-drain.ts';
import * as lease from '../src/core/persistence/claim-lease.ts';
import type { SyncResult } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-drain-fingerprint-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const guard = async <T>(work: Promise<T>, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not return')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};
const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0,
  chunksCreated: 0, embedded: 0, pagesAffected: [] };
const pending = (row: WriteRequest): SyncResult => ({ ...base, status: 'partial', reason: 'writer_pending', managedCursor: { index: 0, total: 1 },
  managedWrite: { source_id: row.source_id, slug: row.slug!, path: `${row.slug}.md`, write_error: 'write_pending', reason: 'write_pending', message: 'pending', suggestion: 'wait',
    write_request: { request_id: row.id, state: 'running', retry_after_ms: 0 } as never } });
const done = (): SyncResult => ({ ...base, managedCursor: { index: 1, total: 1 } });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function rows(count = 6): Promise<WriteRequest[]> {
  const id = `stall-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nObservation ${i}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root); await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  await disposePersistenceConsumer(engine);
  const reopened = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),completed_at=NULL,published_at=NULL,
    claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' RETURNING *`, [id]);
  reopened.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const bytes = reopened.reduce((sum, row) => sum + Number(row.intent_bytes), 0);
  await engine.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+$2,intent_bytes=intent_bytes+$3 WHERE key=ANY($1::text[])',
    [['brain', principalKey(requestPrincipal(reopened[0]!))], reopened.length, bytes]);
  return reopened;
}

async function progress(row: WriteRequest): Promise<number | null> {
  const [got] = await engine.executeRaw<{ progress: string | null }>("SELECT claim_phase->>'progress' AS progress FROM persistence_requests WHERE id=$1::uuid", [row.id]);
  return got?.progress == null ? null : Number(got.progress);
}
async function pollProgress(row: WriteRequest, wanted: number): Promise<void> {
  let observed: number | null = null;
  for (let i = 0; i < 10; i++) { observed = await progress(row); if (observed === wanted) return; await Bun.sleep(25); }
  throw new Error(`claim progress did not reach ${wanted}; observed ${observed}`);
}

test('the default stall window safely covers preparation silence and renewal latency', () => {
  expect(typeof drain.STALL_WINDOW_MS).toBe('number');
  expect(typeof lease.DEFAULT_PREPARATION_MS).toBe('number');
  expect(drain.STALL_WINDOW_MS).toBeGreaterThanOrEqual(lease.DEFAULT_PREPARATION_MS! + lease.DEFAULT_CLAIM_LEASE_TIMING.everyMs + lease.DEFAULT_CLAIM_LEASE_TIMING.deadlineMs);
  expect(drain.STALL_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
});

test('renewing-but-stuck rows keep one fingerprint and end the drain as drain_stalled', async () => {
  const [row] = await rows(1); const since = new Date().toISOString();
  await engine.executeRaw(`UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid`,
    [row!.id, JSON.stringify({ phase: 'preparing', since, progress: 0, token: row!.execution_token })]);
  const probe = drain.engineStallProbe(engine); const result = pending(row!);
  const first = await probe.fingerprint(result);
  await engine.executeRaw("UPDATE persistence_requests SET updated_at=now(),claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid", [row!.id]);
  expect((await probe.fingerprint(result))?.key).toBe(first?.key);
  const drained = await guard(drain.runDrain({ probe, stallMs: 50, pauseMs: 5, pass: async () => {
    await engine.executeRaw("UPDATE persistence_requests SET updated_at=now(),claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid", [row!.id]); return result;
  } }));
  expect(drained.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled' });
});

test('real group preparation persists increasing progress and changes the fingerprint', async () => {
  const rs = await rows(); const gates = Array.from({ length: 6 }, () => Promise.withResolvers<void>()); let calls = 0; const left: boolean[] = [];
  const probe = drain.engineStallProbe(engine); const result = pending(rs[0]!);
  const call = executeClaimedGroup(engine, rs, { hostId: randomUUID(), settled() {}, lease: { everyMs: 25, deadlineMs: 1_000 }, preparationMs: 400,
    prepare: async () => { const mine = gates[calls++]!; await mine.promise; throw new Error('controlled failure'); },
    leftRunning: (_work, blocksRoot) => left.push(blocksRoot) });
  while (calls < 4) await Bun.sleep(5);
  gates[0]!.resolve(); await pollProgress(rs[0]!, 1);
  const before = await probe.fingerprint(result);
  gates[1]!.resolve(); await pollProgress(rs[0]!, 2);
  expect((await probe.fingerprint(result))?.key).not.toBe(before?.key);
  gates[2]!.resolve(); await pollProgress(rs[0]!, 3);
  gates[3]!.resolve();
  while (calls < 6) await Bun.sleep(5);
  gates[4]!.resolve(); gates[5]!.resolve();
  expect(typeof await guard(call)).toBe('boolean');
  const end = await engine.executeRaw<{ state: string; execution_token: string | null; blocked_reason: string | null }>(
    'SELECT state,execution_token,blocked_reason FROM persistence_requests WHERE id=ANY($1::uuid[])', [rs.map(r => r.id)]);
  expect(end.some(r => r.blocked_reason === 'preparation_deadline')).toBe(false);
  expect(end.some(r => r.state === 'running' && r.execution_token !== null)).toBe(false);
  expect(left).not.toContain(true);
});

test('an abandoned real group freezes persisted progress and fingerprint after its deadline', async () => {
  const rs = await rows();
  expect(await guard(executeClaimedGroup(engine, rs, { hostId: randomUUID(), settled() {}, lease: { everyMs: 25, deadlineMs: 1_000 }, preparationMs: 150,
    prepare: () => new Promise(() => {}) }))).toBe(false);
  const probe = drain.engineStallProbe(engine); const result = pending(rs[0]!); const samples: Array<[number | null, string | undefined]> = [];
  for (let i = 0; i < 3; i++) { samples.push([await progress(rs[0]!), (await probe.fingerprint(result))?.key]); await Bun.sleep(125); }
  expect(samples[1]).toEqual(samples[0]); expect(samples[2]).toEqual(samples[0]);
  const end = await engine.executeRaw<{ state: string; execution_token: string | null; blocked_reason: string | null }>(
    'SELECT state,execution_token,blocked_reason FROM persistence_requests WHERE id=ANY($1::uuid[])', [rs.map(r => r.id)]);
  expect(end.every(r => r.state === 'queued' && r.execution_token === null && r.blocked_reason === 'preparation_deadline')).toBe(true);
});

test('a released preparation_deadline head stalls even though it is claimable here', async () => {
  const rs = await rows();
  await guard(executeClaimedGroup(engine, rs, { hostId: localHostId(), settled() {}, lease: { everyMs: 25, deadlineMs: 1_000 }, preparationMs: 100,
    prepare: () => new Promise(() => {}) }));
  expect(await hasClaimableWrite(engine, localHostId())).toBe(true);
  const result = pending(rs[0]!); const probe = drain.engineStallProbe(engine);
  const stalled = await guard(drain.runDrain({ probe, stallMs: 100, pauseMs: 5, pass: async () => result }));
  expect(stalled.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { head_blocked_reason: 'preparation_deadline' } });
  const next = drain.drainNext(stalled, 'gbrain sync', 'src');
  expect(next?.why).toContain('gave up preparing'); expect(next?.why).not.toContain('nothing here can claim it');
  expect(drain.formatDrainSummary(stalled, 'gbrain sync', 'src').join('\n')).toContain('head blocked_reason=preparation_deadline');

  let passes = 0;
  const control = await guard(drain.runDrain({ probe, stallMs: 20, pauseMs: 1, pass: async () => {
    if (++passes >= 20) return done();
    await engine.executeRaw("UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),blocked_reason=NULL,claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid", [rs[0]!.id]);
    return result;
  } }), 1_000);
  expect(control.drain?.stop_reason).not.toBe('drain_stalled');
});

test('changing heads and page_committed events reset the stall window', async () => {
  const rs = await rows(1); const result = pending(rs[0]!); const probe = drain.engineStallProbe(engine); let passes = 0;
  const progressed = await drain.runDrain({ probe, stallMs: 10, pauseMs: 2, pass: async () => {
    if (++passes === 8) return done();
    await engine.executeRaw("UPDATE persistence_requests SET execution_token=gen_random_uuid(),claim_phase=jsonb_set(COALESCE(claim_phase,'{}'::jsonb),'{phase}','\"publishing\"') WHERE id=$1::uuid", [rs[0]!.id]);
    return result;
  } });
  expect(progressed.drain?.outcome).toBe('synced');
  passes = 0;
  const committed = await drain.runDrain({ probe: { blockedHead: async () => null, fingerprint: async () => ({ key: 'same',
    stall: { request_id: 'r', state: 'running', blocked_reason: null, head_request_id: 'r', head_state: 'running', claimable_here: false, owner_is_this_host: true } }) },
  stallMs: 10, pauseMs: 2, pass: async (_signal, onProgress) => { onProgress({ phase: 'managed_sync.page_committed' }); return ++passes === 8 ? done() : result; } });
  expect(committed.drain?.outcome).toBe('synced');
});
