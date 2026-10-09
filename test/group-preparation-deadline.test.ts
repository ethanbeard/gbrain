/** Group claims stop renewing after preparation makes no progress; consumer wiring forwards the same budget and signal. */
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
import { executeClaimedGroup, type GroupExecution } from '../src/core/persistence/group-publish.ts';
import { PersistenceConsumer, type PrepareMutation } from '../src/core/persistence/consumer.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-group-deadline-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const guard = async <T>(work: Promise<T>, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('group call did not return')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

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
  const id = `deadline-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nObservation ${i}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
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

const state = (rs: WriteRequest[]) => engine.executeRaw<{ id: string; state: string; execution_token: string | null; blocked_reason: string | null }>(
  'SELECT id,state,execution_token,blocked_reason FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [rs.map(r => r.id)]);
const run = (prepare: GroupExecution['prepare'], extra: Partial<GroupExecution> = {}) => ({ hostId: randomUUID(), settled() {}, prepare,
  lease: { everyMs: 20, deadlineMs: 1_000 }, preparationMs: 200, ...extra });

test('a group whose preparation never settles under a renewing owner releases every member with preparation_deadline', async () => {
  const rs = await rows(); let passed: AbortSignal | undefined; const left: boolean[] = [];
  const result = await guard(executeClaimedGroup(engine, rs, run((_row, _engine, signal) => { passed = signal; return new Promise(() => {}); },
    { leftRunning: (_work, blocksRoot) => left.push(blocksRoot) })));
  expect(result).toBe(false);
  expect(await state(rs)).toEqual(rs.map(r => ({ id: r.id, state: 'queued', execution_token: null, blocked_reason: 'preparation_deadline' })));
  expect(left).toEqual([true]);
  expect(passed?.aborted).toBe(true);
  expect(passed?.reason).toMatchObject({ code: 'preparation_deadline' });
});

test('a group whose members keep settling is not cut off', async () => {
  const rs = await rows(); const left: boolean[] = [];
  const result = await guard(executeClaimedGroup(engine, rs, run(async () => { await Bun.sleep(120); throw new Error('prepared failure'); },
    { leftRunning: (_work, blocksRoot) => left.push(blocksRoot) })));
  expect(typeof result).toBe('boolean');
  expect((await state(rs)).some(r => r.blocked_reason === 'preparation_deadline')).toBe(false);
  expect(left).not.toContain(true);
});

test('lost claim releases only claims still owned with claim_lost', async () => {
  const rs = await rows();
  const call = executeClaimedGroup(engine, rs, run(() => new Promise(() => {}), { preparationMs: 2_000 }));
  await Bun.sleep(60);
  const replacement = randomUUID();
  await engine.executeRaw('UPDATE persistence_requests SET execution_token=$2::uuid WHERE id=$1::uuid', [rs[0]!.id, replacement]);
  expect(await guard(call)).toBe(false);
  const got = await state(rs);
  expect(got[0]).toMatchObject({ state: 'running', execution_token: replacement });
  expect(got.slice(1).every(r => r.state === 'queued' && r.execution_token === null && r.blocked_reason === 'claim_lost')).toBe(true);
  expect(got.some(r => r.blocked_reason === 'preparation_deadline')).toBe(false);
});

test('late settlement after the deadline starts no later preparation round', async () => {
  const rs = await rows(); const gate = Promise.withResolvers<void>(); let calls = 0, left = 0;
  const call = executeClaimedGroup(engine, rs, run(async () => { calls++; await gate.promise; throw new Error('late'); },
    { preparationMs: 100, leftRunning: (_work, blocksRoot) => { if (blocksRoot) left++; } }));
  expect(await guard(call)).toBe(false);
  gate.resolve(); await Bun.sleep(300);
  expect(calls).toBe(4); expect(left).toBe(1);
  expect(await state(rs)).toEqual(rs.map(r => ({ id: r.id, state: 'queued', execution_token: null, blocked_reason: 'preparation_deadline' })));
});

test('consumer group execution forwards the configured/default budget and exact signal', async () => {
  let seen: Parameters<PrepareMutation> | undefined;
  const prepare: PrepareMutation = async (...args) => { seen = args; throw new Error('spy'); };
  const configured = new PersistenceConsumer(engine, { engine: 'pglite' } as never, prepare, { preparationMs: 1234 });
  const defaults = new PersistenceConsumer(engine, { engine: 'pglite' } as never, prepare);
  type Exposed = { groupExecution(root: object, lane: null): GroupExecution };
  const a = (configured as unknown as Exposed).groupExecution({}, null);
  const b = (defaults as unknown as Exposed).groupExecution({}, null);
  expect(a.preparationMs).toBe(1234); expect(b.preparationMs).toBe(30_000);
  const signal = new AbortController().signal; const member = {} as WriteRequest;
  await expect(a.prepare(member, engine, signal)).rejects.toThrow('spy');
  expect(seen).toEqual([engine, member, configured.config, signal]);
});
