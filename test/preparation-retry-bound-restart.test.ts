import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync/perform.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { executeClaimedGroup, type GroupExecution } from '../src/core/persistence/group-publish.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { renewGroupClaims } from '../src/core/persistence/journal.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const commit = (root: string, message: string) => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
};

// The tests close engines in their own finally blocks; this registry is the
// shard-level backstop if an assertion interrupts that cleanup.
const openEngines = new Set<PGLiteEngine>();
beforeAll(() => {});
afterAll(async () => {
  for (const engine of openEngines) {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  }
  openEngines.clear();
});
function createEngine(): PGLiteEngine {
  const engine = new PGLiteEngine();
  openEngines.add(engine);
  return engine;
}
async function closeEngine(engine: PGLiteEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  openEngines.delete(engine);
}

async function fixtureRows(engine: PGLiteEngine, home: string, count = 4): Promise<WriteRequest[]> {
  const id = `bound-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nBody ${i}.\n`);
  }
  commit(root, 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  await disposePersistenceConsumer(engine);
  const got = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),completed_at=NULL,published_at=NULL,
    error_code=NULL,error_message=NULL,claim_phase=NULL,claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL
    WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' RETURNING *`, [id]);
  got.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const bytes = got.reduce((sum, row) => sum + Number(row.intent_bytes), 0);
  await engine.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+$2,intent_bytes=intent_bytes+$3 WHERE key=ANY($1::text[])',
    [['brain', principalKey(requestPrincipal(got[0]!))], got.length, bytes]);
  return got;
}

const execution = (prepare: GroupExecution['prepare']): GroupExecution => ({
  hostId: randomUUID(), settled() {}, prepare, preparationMs: 60,
  lease: { everyMs: 10, deadlineMs: 500 },
});

async function reclaim(engine: PGLiteEngine, ids: string[]): Promise<WriteRequest[]> {
  const got = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),
    claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL WHERE id=ANY($1::uuid[]) AND state='queued' RETURNING *`, [ids]);
  got.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  return got;
}

test('preparation-abandon strikes survive a file-backed engine restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-preparation-restart-'));
  const database_path = join(dir, 'brain.pglite');
  let a: PGLiteEngine | undefined;
  let b: PGLiteEngine | undefined;
  try {
    a = createEngine();
    await a.connect({ database_path });
    await a.initSchema();
    let rows = await fixtureRows(a, dir);
    const ids = rows.map(row => row.id);
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await executeClaimedGroup(a, rows, execution(() => new Promise(() => {})))).toBe(false);
      const strikes = await a.executeRaw<{ count: string; state: string }>(
        "SELECT claim_phase->>'preparation_abandoned' AS count,state FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence", [ids]);
      expect(strikes.every(row => Number(row.count) === attempt && row.state === 'queued')).toBe(true);
      rows = await reclaim(a, ids);
    }
    const renewed = await renewGroupClaims(a, rows, 30_000, undefined, JSON.stringify({ phase: 'preparing', since: new Date().toISOString(), progress: 0 }));
    expect(renewed.size).toBe(rows.length);
    const beforeRestart = await a.executeRaw<{ id: string; state: string; execution_token: string | null; count: string }>(
      "SELECT id,state,execution_token,claim_phase->>'preparation_abandoned' AS count FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence", [ids]);
    expect(beforeRestart.every((row, index) => row.state === 'running' && row.execution_token === rows[index]!.execution_token)).toBe(true);
    expect(beforeRestart.every(row => Number(row.count) === 2)).toBe(true);
    await closeEngine(a);
    a = undefined;

    b = createEngine();
    await b.connect({ database_path });
    await b.initSchema();
    const reopened = await b.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [ids]);
    expect(reopened.every(row => Number(((row as WriteRequest & { claim_phase?: Record<string, unknown> | null }).claim_phase)?.preparation_abandoned) === 2)).toBe(true);
    expect(await executeClaimedGroup(b, reopened, execution(() => new Promise(() => {})))).toBe(false);
    const terminal = await b.executeRaw<{ state: string; error_code: string | null }>(
      'SELECT state,error_code FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [ids]);
    expect(terminal.every(row => row.state === 'failed' && row.error_code === 'preparation_abandoned_3x')).toBe(true);
  } finally {
    if (a) await closeEngine(a);
    if (b) await closeEngine(b);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

async function terminalPreparationFailure(engine: PGLiteEngine, home: string, holds: 'hold' | 'fail') {
  const id = `stall-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const root = join(home, id);
  const path = 'notes/n.md';
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, path), '---\ntitle: N\n---\nFirst.\n');
  commit(root, 'first');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true })).status).toBe('first_sync');
  await disposePersistenceConsumer(engine);
  if (holds === 'fail') await engine.setConfig('sync.holds', 'fail');
  else await engine.unsetConfig('sync.holds');

  writeFileSync(join(root, path), '---\ntitle: N\n---\nSecond.\n');
  commit(root, 'second');
  let blocker: { id: string; state: string } | undefined;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:mid_checkpoint' || detail.sourceId !== id || blocker) return;
    const [cursor] = await engine.executeRaw<{ request_id: string | null; path: string | null }>(`SELECT completed_keys->0->'pending'->>'requestId' AS request_id,
      completed_keys->0->'pending'->'intent'->>'path' AS path FROM op_checkpoints
      WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [id]);
    if (cursor?.path !== path || !cursor.request_id) return;
    const [old] = await engine.executeRaw<{ id: string; state: string }>(
      "SELECT id,state FROM persistence_requests WHERE source_id=$1 AND state='committed' ORDER BY sequence LIMIT 1", [id]);
    if (!old) throw new Error('fixture has no earlier committed request to hold the worktree FIFO');
    blocker = old;
    await engine.executeRaw(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),
      claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL WHERE id=$1::uuid`, [old.id]);
  });
  let pendingResult;
  try {
    pendingResult = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: false });
  } finally {
    installFaultHook(undefined);
  }
  expect(pendingResult).toMatchObject({ status: 'partial', reason: 'writer_pending' });
  expect(blocker).toBeDefined();
  const [request] = await engine.executeRaw<WriteRequest>(
    "SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' AND intent->>'path'=$2 ORDER BY sequence DESC LIMIT 1", [id, path]);
  expect(request).toMatchObject({ state: 'queued' });
  await disposePersistenceConsumer(engine);
  await engine.executeRaw(`UPDATE persistence_requests SET state='committed',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL
    WHERE id=$1::uuid`, [blocker!.id]);
  const keys = ['brain', principalKey(requestPrincipal(request!))];
  await engine.executeRaw(`WITH done AS (UPDATE persistence_requests SET state='failed',outcome='{}'::jsonb,
      error_code='preparation_abandoned_3x',error_message=$2,completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL
      WHERE id=$1::uuid AND state='queued' RETURNING intent_bytes)
    UPDATE persistence_counters SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-(SELECT intent_bytes FROM done)
    WHERE key=ANY($3::text[]) AND EXISTS (SELECT 1 FROM done)`,
  [request!.id, `Preparation of ${request!.slug} was abandoned three times.`, keys]);

  const result = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  return { id, path, result, hold: await readGitHold(engine, id, source!.incarnation, path) };
}

test('managed sync converts preparation exhaustion to a hold, but holds=fail remains blocked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-preparation-sync-'));
  const engine = createEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    const held = await terminalPreparationFailure(engine, home, 'hold');
    expect(held.hold).toMatchObject({ path: held.path, code: 'preparation_abandoned_3x' });
    expect(held.result.status).not.toBe('blocked_by_failures');
    expect(held.result).toMatchObject({ held_count: 1, drain: { outcome: 'synced', held: 1 } });

    await disposePersistenceConsumer(engine);
    const failed = await terminalPreparationFailure(engine, home, 'fail');
    expect(failed.hold).toBeNull();
    expect(failed.result).toMatchObject({
      status: 'blocked_by_failures',
      failureCodes: [{ code: 'preparation_abandoned_3x', count: 1 }],
      drain: { outcome: 'blocked', stop_reason: 'blocked_by_failures', held: 0 },
    });
  } finally {
    installFaultHook(undefined);
    await engine.unsetConfig('sync.holds').catch(() => undefined);
    await closeEngine(engine);
    rmSync(home, { recursive: true, force: true });
  }
}, 180_000);
