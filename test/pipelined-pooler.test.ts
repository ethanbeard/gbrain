import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { resolvePrepare } from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { groupReads } from '../src/core/persistence/group-publish.ts';
import {
  composablePostgresTransaction,
  pipelined,
  PipelinedCallDeadlineError,
  resolvePipelinedDeadlineMs,
  TRANSACTION_POOLER,
} from '../src/core/page-state/transactions.ts';

const previousDeadline = process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS;
const previousPrepare = process.env.GBRAIN_PREPARE;

afterEach(() => {
  if (previousDeadline === undefined) delete process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS;
  else process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = previousDeadline;
  if (previousPrepare === undefined) delete process.env.GBRAIN_PREPARE;
  else process.env.GBRAIN_PREPARE = previousPrepare;
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function callableHandle(extra: Record<PropertyKey, unknown> = {}) {
  return Object.assign(function sql() {}, extra);
}

function orderedCalls(log: string[]) {
  return [0, 1, 2].map(i => async () => {
    log.push(`start${i}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    log.push(`end${i}`);
    return `r${i}`;
  });
}

function poolerTx(discard = () => {}) {
  const handle = callableHandle({ discard, savepoint: async (fn: (child: unknown) => unknown) => fn(handle) });
  return { handle, tx: composablePostgresTransaction(handle, { options: { prepare: false } }) };
}

describe('pipelined transaction-pooler policy', () => {
  test('T1 runs pooler calls sequentially and preserves results', async () => {
    const { tx } = poolerTx();
    const log: string[] = [];
    expect(await pipelined({ kind: 'postgres', sql: tx }, orderedCalls(log))).toEqual(['r0', 'r1', 'r2']);
    expect(log).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  });

  test('T2 stops at the first rejection or synchronous throw', async () => {
    const { tx } = poolerTx();
    const failure = new Error('A');
    let later = 0;
    await expect(pipelined({ kind: 'postgres', sql: tx }, [async () => 'ok', async () => { throw failure; }, async () => { later++; }])).rejects.toBe(failure);
    expect(later).toBe(0);
    const syncFailure = new Error('sync');
    await expect(pipelined({ kind: 'postgres', sql: tx }, [() => { throw syncFailure; }])).rejects.toBe(syncFailure);
  });

  test('T3 deadlines discard once and never invoke a later call', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '50';
    let discards = 0;
    let later = 0;
    const { tx } = poolerTx(() => { discards++; });
    const started = Date.now();
    const result = pipelined({ kind: 'postgres', sql: tx }, [async () => 'ok', async function stalledCall() { return new Promise(() => {}); }, async () => { later++; }]);
    const error = await result.catch(value => value);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.code).toBe('PIPELINED_CALL_DEADLINE');
    expect(error.message).toContain('call 2/3');
    expect(error.message).toContain('stalledCall');
    expect(error.message).toContain('connection discarded');
    expect(discards).toBe(1);
    expect(later).toBe(0);
  });

  test('T4 reports when a root pool has no discard handle', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '20';
    const error = await pipelined({ kind: 'postgres', sql: { options: { prepare: false } } }, [async () => new Promise(() => {})]).catch(value => value);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.message).toContain('NO DISCARD HANDLE: connection not discarded');
  });

  test('T5 real vendored pools carry resolvePrepare policy', async () => {
    delete process.env.GBRAIN_PREPARE;
    const makePool = (url: string) => {
      const prepare = resolvePrepare(url);
      return postgres(url, typeof prepare === 'boolean' ? { prepare } : {});
    };
    const pooler = makePool('postgresql://u:p@127.0.0.1:6543/d');
    const direct = makePool('postgresql://u:p@127.0.0.1:5432/d');
    try {
      expect(pooler.options.prepare).toBe(false);
      expect(direct.options.prepare).toBe(true);
      const fake = callableHandle({ discard() {}, savepoint: async () => undefined });
      const sequential = composablePostgresTransaction(fake, pooler);
      const piped = composablePostgresTransaction(fake, direct);
      const sequentialLog: string[] = [];
      await pipelined({ kind: 'postgres', sql: sequential }, orderedCalls(sequentialLog));
      expect(sequentialLog).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
      const gates = [deferred(), deferred(), deferred()];
      const pipedLog: string[] = [];
      const running = pipelined({ kind: 'postgres', sql: piped }, gates.map((gate, i) => async () => { pipedLog.push(`start${i}`); await gate.promise; pipedLog.push(`end${i}`); }));
      await Promise.resolve();
      expect(pipedLog).toEqual(['start0', 'start1', 'start2']);
      gates.forEach(gate => gate.resolve());
      await running;
    } finally {
      await Promise.all([pooler.end({ timeout: 0 }), direct.end({ timeout: 0 })]);
    }
  });
});

type BoundaryHarness = {
  engine: PostgresEngine;
  discards: () => number;
};

function boundaryHarness(): BoundaryHarness {
  let discarded = false;
  let discards = 0;
  const closed = () => Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' });
  const scope = async <T>(cb: (handle: unknown) => Promise<T>, handle: ReturnType<typeof callableHandle>): Promise<T> => {
    try { return await cb(handle); }
    catch (original) {
      try { if (discarded) throw closed(); }
      catch (rollback) { throw rollback; }
      throw original;
    }
  };
  const handle = callableHandle({
    discard() { discarded = true; discards++; },
    savepoint<T>(cb: (child: unknown) => Promise<T>) { return scope(cb, child); },
  });
  const child = callableHandle({
    discard: handle.discard,
    savepoint<T>(cb: (nested: unknown) => Promise<T>) { return scope(cb, child); },
  });
  const pool = callableHandle({ options: { prepare: false }, begin: <T>(cb: (tx: unknown) => Promise<T>) => scope(cb, handle) });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = pool;
  return { engine, discards: () => discards };
}

async function stallForever(): Promise<never> { return new Promise(() => {}); }

describe('deadline restoration at engine boundaries', () => {
  test('T6(a) transaction restores the deadline error', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '20';
    const { engine, discards } = boundaryHarness();
    let later = 0;
    const error = await engine.transaction(tx => pipelined(tx, [async () => 'ok', () => stallForever(), async () => { later++; }])).catch(value => value);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.code).toBe('PIPELINED_CALL_DEADLINE');
    expect(error.message).toContain('stallForever');
    expect(error.code).not.toBe('CONNECTION_CLOSED');
    expect(discards()).toBe(1);
    expect(later).toBe(0);
  });

  test('T6(b) savepoint restores the deadline error', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '20';
    const { engine, discards } = boundaryHarness();
    const error = await engine.transaction(tx => (tx as unknown as { sql: { begin<T>(cb: (child: unknown) => Promise<T>): Promise<T> } }).sql.begin(child =>
      pipelined({ kind: 'postgres', sql: child }, [() => stallForever()]))).catch(value => value);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.message).toContain('stallForever');
    expect(discards()).toBe(1);
  });

  test('T6(c) engine-level nested transaction inherits pooler policy', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '20';
    const { engine, discards } = boundaryHarness();
    let inherited = false;
    const error = await engine.transaction(tx => tx.transaction(inner => {
      inherited = (inner as unknown as { sql: { [TRANSACTION_POOLER]: boolean } }).sql[TRANSACTION_POOLER];
      return pipelined(inner, [() => stallForever()]);
    })).catch(value => value);
    expect(inherited).toBe(true);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.message).toContain('stallForever');
    expect(discards()).toBe(1);
  });

  test('T6(d) groupReads preserves sql policy and discard handles', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '20';
    const { engine, discards } = boundaryHarness();
    const error = await engine.transaction(tx => pipelined(groupReads(tx), [() => stallForever()])).catch(value => value);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    expect(error.message).toContain('connection discarded');
    expect(discards()).toBe(1);
  });
});

describe('nested and overlapping deadlines', () => {
  test('T7(a) nested work cannot outlive its enclosing deadline', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '100';
    let discards = 0;
    const { tx } = poolerTx(() => { discards++; });
    const started = Date.now();
    let nested!: Promise<unknown[]>;
    const error = await pipelined({ kind: 'postgres', sql: tx }, [async () => {
      process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '1000';
      nested = pipelined({ kind: 'postgres', sql: tx }, [() => stallForever()]);
      return nested;
    }]).catch(value => value);
    expect(Date.now() - started).toBeLessThan(500);
    expect(error).toBeInstanceOf(PipelinedCallDeadlineError);
    const nestedError = await Promise.race([nested.catch(value => value), new Promise(resolve => setTimeout(() => resolve('nested did not inherit deadline'), 200))]);
    expect(nestedError).toBe(error);
    expect(discards).toBe(1);
  });

  test('T7(b) overlapping batches share the first recorded error', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '30';
    let discards = 0;
    const { tx } = poolerTx(() => { discards++; });
    const [first, second] = await Promise.all([
      pipelined({ kind: 'postgres', sql: tx }, [() => stallForever()]).catch(value => value),
      pipelined({ kind: 'postgres', sql: tx }, [() => stallForever()]).catch(value => value),
    ]);
    expect(first).toBe(second);
    expect(discards).toBe(1);
  });
});

describe('budget and unchanged paths', () => {
  test('T8 parses the call deadline budget', () => {
    for (const value of [undefined, '', 'abc', '0', '-5']) {
      if (value === undefined) delete process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS;
      else process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = value;
      expect(resolvePipelinedDeadlineMs()).toBe(120_000);
    }
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '250';
    expect(resolvePipelinedDeadlineMs()).toBe(250);
  });

  test('T9 PGLite stays sequential without a deadline', async () => {
    process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS = '50';
    expect(await pipelined({ kind: 'pglite' }, [async () => { await new Promise(resolve => setTimeout(resolve, 100)); return 'ok'; }])).toEqual(['ok']);
  });

  test('T10 non-pooler Postgres keeps pipelining and failure selection', async () => {
    const tx = composablePostgresTransaction(callableHandle({ savepoint: async () => undefined }), { options: { prepare: true } });
    const gates = [deferred(), deferred(), deferred()];
    const log: string[] = [];
    const running = pipelined({ kind: 'postgres', sql: tx }, gates.map((gate, i) => async () => { log.push(`start${i}`); await gate.promise; log.push(`end${i}`); }));
    await Promise.resolve();
    expect(log).toEqual(['start0', 'start1', 'start2']);
    gates.forEach(gate => gate.resolve());
    await running;
    const aborted = Object.assign(new Error('aborted'), { code: '25P02' });
    const failure = new Error('B');
    await expect(pipelined({ kind: 'postgres', sql: tx }, [() => Promise.reject(aborted), () => Promise.reject(failure)])).rejects.toBe(failure);
  });
});
