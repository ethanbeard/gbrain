import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncOpts, SyncResult } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findIncompleteSyncReceipt } from '../src/core/persistence/checkpoint-validation.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-dropped-receipts-'));
const env = {
  GBRAIN_HOME: home,
  GBRAIN_SYNC_FAILURES_DIR: home,
  GBRAIN_SOURCE: undefined,
  OPENAI_API_KEY: undefined,
  VOYAGE_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};
const BULK = { enabled: true, reason: null, size: 4, maxTxnMs: 15_000, maxTxnExplicit: false };
let engine: BrainEngine;

interface Receipt {
  request_id: string;
  slug: string;
  state: string;
  grp: string | null;
  error_message: string | null;
  worktree_id: string;
}

interface StoredCursor {
  runId: string;
  droppedRequests?: string[];
}

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const ordinary = (i: number) => `---\ntitle: N${i}\n---\nOrdinary note ${i}.\n`;
const conflicting = (i: number) => `---\ntitle: C${i}\nslug: notes/other${i}\n---\nConflicting identity ${i}.\n`;

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

async function fixture(conflicts: number[]) {
  const sourceId = `drop-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (let i = 0; i < 10; i++) writeFileSync(join(root, `notes/n${i}.md`), conflicts.includes(i) ? conflicting(i) : ordinary(i));
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base: SyncOpts = {
    sourceId, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [], bulk: BULK,
  };
  return { sourceId, root, base };
}

async function failClosed(base: SyncOpts): Promise<SyncResult> {
  await engine.setConfig('sync.holds', 'fail');
  try {
    return await performManagedSync(engine, base);
  } finally {
    await engine.unsetConfig('sync.holds');
  }
}

const receipts = (sourceId: string, runId: string) => engine.executeRaw<Receipt>(
  `SELECT request_id::text,slug,state,intent->>'group' AS grp,error_message,worktree_id::text
     FROM persistence_requests
    WHERE source_id=$1 AND intent->>'runId'=$2 AND intent->>'kind'='managed_sync_import'
    ORDER BY sequence`, [sourceId, runId]);

async function storedCursor(sourceId: string): Promise<StoredCursor> {
  const [row] = await engine.executeRaw<{ cursor: StoredCursor }>(
    `SELECT completed_keys->0 AS cursor FROM op_checkpoints
      WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [sourceId]);
  expect(row).toBeDefined();
  return row!.cursor;
}

async function d1RunOne() {
  const f = await fixture([3, 5]);
  const first = await failClosed(f.base);
  expect(first).toMatchObject({ status: 'blocked_by_failures', managedWrite: { slug: 'notes/n3' } });
  const rows = await receipts(f.sourceId, first.runId!);
  expect(rows.filter(row => row.state === 'cancelled').map(row => row.slug)).toEqual(['notes/n4', 'notes/n5']);
  const cursor = await storedCursor(f.sourceId);
  return { f, first, rows, cursor };
}

function expectDroppedPopulation(rows: Receipt[], cursor: StoredCursor) {
  const cancelled = rows.filter(row => row.state === 'cancelled').map(row => row.request_id);
  expect(new Set(cursor.droppedRequests)).toEqual(new Set(cancelled));
  expect(rows.filter(row => row.state === 'committed').every(row => !cursor.droppedRequests!.includes(row.request_id))).toBe(true);
  expect(cursor.droppedRequests).not.toContain(rows.find(row => row.slug === 'notes/n3')!.request_id);
}

async function expectCompleted(f: Awaited<ReturnType<typeof fixture>>, first: SyncResult) {
  const second = await performManagedSync(engine, f.base);
  expect(second).toMatchObject({ status: 'first_sync', runId: first.runId, held_count: 2 });
  const [checkpoint] = await engine.executeRaw<{ state: string }>(
    `SELECT state FROM persistence_requests
      WHERE source_id=$1 AND intent->>'runId'=$2 AND intent->>'kind'='managed_sync_checkpoint'`, [f.sourceId, first.runId]);
  expect(checkpoint?.state).toBe('committed');
  for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) expect(await engine.getPage(`notes/n${i}`, { sourceId: f.sourceId })).not.toBeNull();
  for (const i of [3, 5]) expect(await engine.getPage(`notes/n${i}`, { sourceId: f.sourceId })).toBeNull();
  const holdReports = await readGitSourceHolds(engine, { sourceIds: [f.sourceId] });
  expect(holdReports).toHaveLength(1);
  expect(holdReports[0]!.holds.map(hold => hold.path).sort()).toEqual(['notes/n3.md', 'notes/n5.md']);
  const failedId = (await receipts(f.sourceId, first.runId!)).find(row => row.slug === 'notes/n3' && row.state === 'failed')!.request_id;
  expect(second.converted_from_failed).toEqual([failedId]);
  return second;
}

test('D1 records cancelled group followers so held retries can commit the checkpoint', () => withEnv(env, async () => {
  const { f, first, rows, cursor } = await d1RunOne();
  await expectCompleted(f, first);
  expectDroppedPopulation(rows, cursor);
}), 240_000);

test('D2 records a conflict-state dropped follower as superseded', () => withEnv(env, async () => {
  const { f, first, rows } = await d1RunOne();
  const dropped = rows.find(row => row.slug === 'notes/n5')!;
  // PGLite cannot race lanes; this stands in for a dropped member that a lane published into a conflict.
  await engine.executeRaw("UPDATE persistence_requests SET state='conflict' WHERE request_id=$1::uuid", [dropped.request_id]);
  await expectCompleted(f, first);
}), 240_000);

test('D3 records cancelled admit-ahead window members', () => withEnv(env, async () => {
  const f = await fixture([2, 7]);
  const base = { ...f.base, drainStartedAt: Date.now() };
  const first = await failClosed(base);
  expect(first).toMatchObject({ status: 'blocked_by_failures', managedWrite: { slug: 'notes/n2' } });
  const rows = await receipts(f.sourceId, first.runId!);
  const failed = rows.find(row => row.slug === 'notes/n2')!;
  const ahead = rows.find(row => row.slug === 'notes/n7')!;
  expect(ahead).toMatchObject({ state: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE });
  expect(ahead.grp).not.toBe(failed.grp);
  const cursor = await storedCursor(f.sourceId);
  const second = await performManagedSync(engine, { ...f.base, drainStartedAt: Date.now() });
  expect(second).toMatchObject({ status: 'first_sync', runId: first.runId });
  expect(cursor.droppedRequests).toContain(ahead.request_id);
  const [checkpoint] = await engine.executeRaw<{ state: string }>(
    `SELECT state FROM persistence_requests
      WHERE source_id=$1 AND intent->>'runId'=$2 AND intent->>'kind'='managed_sync_checkpoint'`, [f.sourceId, first.runId]);
  expect(checkpoint?.state).toBe('committed');
  expect(await engine.getPage('notes/n7', { sourceId: f.sourceId })).toBeNull();
  expect((await readGitSourceHolds(engine, { sourceIds: [f.sourceId] }))[0]!.holds.map(hold => hold.path)).toContain('notes/n7.md');
}), 240_000);

test('V1 superseded receipts still block while open or carrying recovery', () => withEnv(env, async () => {
  const { first, rows, cursor } = await d1RunOne();
  const failedId = rows.find(row => row.slug === 'notes/n3')!.request_id;
  const n4 = rows.find(row => row.slug === 'notes/n4')!.request_id;
  const x = rows.find(row => row.slug === 'notes/n5')!.request_id;
  const worktreeId = rows.find(row => row.slug === 'notes/n5')!.worktree_id;

  await engine.executeRaw("UPDATE persistence_requests SET state='queued' WHERE request_id=$1::uuid", [x]);
  expect(await findIncompleteSyncReceipt(engine, worktreeId, first.runId!, [x])).toBe(x);
  await engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE request_id=$1::uuid", [x]);
  expect(await findIncompleteSyncReceipt(engine, worktreeId, first.runId!, [x])).toBe(x);
  const recovery = { version: 1, path: join(home, 'recovery.md'), root: home, before: null, beforeHash: null,
    afterHash: null, mode: null, ownerEpoch: '1', attempt: randomUUID() };
  await engine.executeRaw("UPDATE persistence_requests SET state='cancelled',recovery=$2::text::jsonb WHERE request_id=$1::uuid", [x, JSON.stringify(recovery)]);
  expect(await findIncompleteSyncReceipt(engine, worktreeId, first.runId!, [x])).not.toBeNull();
  await engine.executeRaw("UPDATE persistence_requests SET recovery=NULL WHERE request_id=$1::uuid", [x]);
  const superseded = [failedId, ...cursor.droppedRequests!];
  expect(superseded).toEqual(expect.arrayContaining([failedId, n4, x]));
  expect(await findIncompleteSyncReceipt(engine, worktreeId, first.runId!, superseded)).toBeNull();
  expect(await findIncompleteSyncReceipt(engine, worktreeId, first.runId!, superseded.filter(id => id !== x))).toBe(x);
}), 240_000);
