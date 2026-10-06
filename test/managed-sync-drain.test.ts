import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncBacklog, runDrain } from '../src/core/persistence/sync-drain.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-drain-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(engine: BrainEngine, count: number) {
  const id = `drain-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('a drain re-enters sliced passes over one cursor until it is synced and records its drain window', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 5);
    const drainStartedAt = Date.now();
    const result = await runDrain({ pass: (signal, onProgress) =>
      performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, signal, onProgress, drainStartedAt }, { maxPages: 1, maxMs: 60_000 }) });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(5);
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 5, waived: 0, remaining: 0 });
    expect(result.drain!.passes).toBeGreaterThanOrEqual(5);
    const requests = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [f.id]);
    expect(requests[0]!.n).toBe(6);
  }
}), 180_000);

test('a stopped drain is resumable, its backlog is readable from any process, and a rerun finishes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 6);
    const stop = new AbortController();
    let committed = 0;
    const drainStartedAt = Date.now();
    const first = await runDrain({ signal: stop.signal, pass: (signal, onProgress) => performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, signal, drainStartedAt,
      onProgress: e => { onProgress(e); if (e.phase === 'managed_sync.page_committed' && ++committed === 2) stop.abort(); } }, { maxPages: 1, maxMs: 60_000 }) });
    expect(first.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline' });
    const [backlog] = await readManagedSyncBacklog(engine, [f.id]);
    expect(backlog).toMatchObject({ source_id: f.id, total: 6, resume_command: `gbrain sync --source ${f.id} --no-pull --no-embed` });
    expect(backlog!.remaining).toBeGreaterThan(0);
    expect(backlog!.rate_pages_per_min).not.toBeNull();
    const second = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, drain: true });
    expect(second.drain?.outcome).toBe('synced');
    expect(second.added).toBe(6);
    expect(await readManagedSyncBacklog(engine, [f.id])).toEqual([]);
  }
}), 180_000);

test('the CLI reports outcome, drain and next in one JSON envelope with the outcome exit code', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_NO_DELEGATE: '1' }, async () => {
  const { runSyncInner } = await import('../src/commands/sync/run.ts');
  const { currentExitCode, _resetCliExitVerdictForTests } = await import('../src/core/cli-force-exit.ts');
  const { registerRunDeadline } = await import('../src/core/forward-progress.ts');
  const engine = engines[0]!;
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    _resetCliExitVerdictForTests();
    try { await runSyncInner(engine, args); } finally { console.log = original; }
    const json = lines.filter(line => line.startsWith('{'));
    expect(json).toHaveLength(1);
    return { envelope: JSON.parse(json[0]!), exit: currentExitCode() ?? 0 };
  };
  const stopped = await fixture(engine, 3);
  registerRunDeadline({ atMs: Date.now() - 1, strict: true });
  try {
    const { envelope, exit } = await capture(['--source', stopped.id, '--no-pull', '--no-embed', '--json']);
    expect(exit).toBe(0);
    expect(envelope).toMatchObject({ outcome: 'resumable', drain: { outcome: 'resumable', stop_reason: 'deadline' },
      next: { safe_to_loop: true, command: expect.stringContaining(`sync --source ${stopped.id} --no-pull --no-embed --json`) } });
  } finally { registerRunDeadline(null); }
  const { envelope, exit } = await capture(['--source', stopped.id, '--no-pull', '--no-embed', '--json']);
  expect(exit).toBe(0);
  expect(envelope).toMatchObject({ sync_status: 'first_sync', outcome: 'synced', drain: { outcome: 'synced', remaining: 0 } });
  expect(envelope.next).toBeUndefined();
}), 180_000);
