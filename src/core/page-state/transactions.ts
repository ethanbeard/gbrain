import type { PGlite, Transaction } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from '#postgres'

export const TRANSACTION_POOLER = Symbol('gbrain.transactionPooler');
const CONNECTION_KEY = Symbol('gbrain.pipelinedConnectionKey');
const pipelinedDeadline = new AsyncLocalStorage<number>();
const pipelinedDeadlineErrors = new WeakMap<object, PipelinedCallDeadlineError>();
const DEFAULT_PIPELINED_CALL_DEADLINE_MS = 120_000;

type SqlHandle = { begin?: (fn: (handle: unknown) => unknown) => unknown; discard?: unknown; options?: { prepare?: unknown }; [TRANSACTION_POOLER]?: unknown; [CONNECTION_KEY]?: unknown };

function readSql(value: unknown): SqlHandle | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function' ? value as SqlHandle : undefined;
}

function connectionKey(sql: unknown): object | undefined {
  const handle = readSql(sql);
  if (!handle) return undefined;
  try {
    const inherited = handle[CONNECTION_KEY];
    if ((typeof inherited === 'object' && inherited !== null) || typeof inherited === 'function') return inherited as object;
    if (typeof handle.discard === 'function') return handle.discard;
    return handle as object;
  } catch {
    return undefined;
  }
}

function recordedDeadline(key: object | undefined): PipelinedCallDeadlineError | undefined {
  return key ? pipelinedDeadlineErrors.get(key) : undefined;
}

/** Preserve a deadline error when postgres.js rollback/onclose masks it. */
export async function beginRestoringDeadline<T>(conn: unknown, cb: (handle: unknown) => Promise<T>): Promise<T> {
  let key: object | undefined;
  try {
    return await (conn as { begin(fn: (handle: unknown) => Promise<T>): Promise<T> }).begin(handle => {
      key = connectionKey(handle);
      return cb(handle);
    });
  } catch (error) {
    throw recordedDeadline(key) ?? error;
  }
}

export class PipelinedCallDeadlineError extends Error {
  readonly code = 'PIPELINED_CALL_DEADLINE';
  constructor(message: string) {
    super(message);
    this.name = 'PipelinedCallDeadlineError';
  }
}

export function resolvePipelinedDeadlineMs(): number {
  const value = Number(process.env.GBRAIN_PIPELINED_CALL_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PIPELINED_CALL_DEADLINE_MS;
}

/** Sibling savepoints must finish in order; children receive a separate queue. */
function serial<T>() {
  let tail: Promise<unknown> = Promise.resolve();
  return (run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Restore the root handle's transaction API on a scoped postgres.js handle. */
export function composablePostgresTransaction(handle: unknown, conn?: unknown): ReturnType<typeof postgres> {
  const tx = handle as ReturnType<typeof postgres> & { savepoint: (fn: (child: unknown) => Promise<unknown>) => Promise<unknown> };
  const run = serial<unknown>();
  const inherited = readSql(conn);
  let transactionPooler = false;
  try { transactionPooler = typeof inherited?.[TRANSACTION_POOLER] === 'boolean' ? inherited[TRANSACTION_POOLER] : inherited?.options?.prepare === false; } catch {}
  let inheritedKey: object | undefined;
  try {
    const key = inherited?.[CONNECTION_KEY];
    if ((typeof key === 'object' && key !== null) || typeof key === 'function') inheritedKey = key as object;
  } catch {}
  inheritedKey ??= connectionKey(handle);
  const proxy = new Proxy(tx, {
    get(target, key, receiver) {
      if (key === TRANSACTION_POOLER) return transactionPooler;
      if (key === CONNECTION_KEY) return inheritedKey;
      if (key === 'begin') return (fn: (child: ReturnType<typeof postgres>) => Promise<unknown>) =>
        run(async () => {
          try { return await tx.savepoint(child => fn(composablePostgresTransaction(child, proxy))); }
          catch (error) { throw recordedDeadline(inheritedKey) ?? error; }
        });
      return Reflect.get(target, key, receiver);
    },
  });
  return proxy;
}

/** PGLite's Transaction omits transaction(); emulate it with real savepoints. */
export function composablePgliteTransaction(handle: Transaction, state = { next: 0 }): PGlite {
  const run = serial<unknown>();
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'transaction') return (fn: (child: PGlite) => Promise<unknown>) => run(async () => {
        const name = `gbrain_nested_${++state.next}`;
        await target.exec(`SAVEPOINT ${name}`);
        try {
          const result = await fn(composablePgliteTransaction(target, state));
          await target.exec(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await target.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          await target.exec(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PGlite;
}

const memos = new WeakMap<object, Map<string, Promise<unknown>>>();
/**
 * #5984: a read every statement of one page transaction may share (the
 * embedding config rows, the local writer, source membership). The first key
 * stores the read; later keys are entries that also satisfy it (a `FOR SHARE`
 * read satisfies a plain one). Outside a page transaction the read runs every
 * time. A rejected read is not kept.
 */
export function transactionMemo<T>(tx: object, keys: string | readonly string[], read: () => Promise<T>): Promise<T> {
  if ((tx as { _pageTransaction?: boolean })._pageTransaction !== true) return read();
  const [key, ...alternatives] = typeof keys === 'string' ? [keys] : keys;
  let byKey = memos.get(tx);
  if (!byKey) { byKey = new Map(); memos.set(tx, byKey); }
  const hit = [key!, ...alternatives].map(k => byKey!.get(k)).find(Boolean);
  if (hit) return hit as Promise<T>;
  const stored = read();
  byKey.set(key!, stored);
  stored.catch(() => byKey!.delete(key!));
  return stored;
}

/**
 * #5984: issues one transaction's statements back to back without awaiting
 * between them, so postgres.js pipelines those already prepared on the
 * transaction's connection (docs/eval/managed-sync-catchup.md, "Pipelining
 * spike": order kept, later statements of a failed pipeline fail with 25P02).
 * A call that awaits between statements sends its later ones after the other
 * calls' first. The first failure in call order that is not a 25P02 abort is
 * thrown (the 25P02 itself when that is all there is). PGLite runs the calls one at a time.
 */
export async function pipelined(engine: object, calls: ReadonlyArray<() => Promise<unknown>>): Promise<unknown[]> {
  if ((engine as { kind?: unknown }).kind !== 'postgres') {
    const results: unknown[] = [];
    for (const call of calls) results.push(await call());
    return results;
  }
  let sql: SqlHandle | undefined;
  try { sql = readSql((engine as { sql?: unknown }).sql); } catch {}
  let transactionPooler = false;
  try {
    const policy = sql?.[TRANSACTION_POOLER];
    transactionPooler = policy === true || (policy === undefined && sql?.options?.prepare === false);
  } catch {}
  if (transactionPooler) {
    const results: unknown[] = [];
    const budget = resolvePipelinedDeadlineMs();
    const enclosing = pipelinedDeadline.getStore();
    const key = connectionKey(sql);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const absoluteDeadline = Math.min(Date.now() + budget, enclosing ?? Number.POSITIVE_INFINITY);
      const label = (() => { try { return Function.prototype.toString.call(call).replace(/\s+/g, ' ').trim().slice(0, 160); } catch { return '<unprintable thunk>'; } })();
      const running = pipelinedDeadline.run(absoluteDeadline, () => Promise.resolve().then(call));
      running.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const prior = recordedDeadline(key);
          if (prior) { reject(prior); return; }
          const discard = (() => { try { return typeof sql?.discard === 'function' ? sql.discard as () => unknown : undefined; } catch { return undefined; } })();
          const error = new PipelinedCallDeadlineError(`Pipelined call ${i + 1}/${calls.length} (${label}) exceeded budget ${budget} ms; ${discard ? 'connection discarded' : 'NO DISCARD HANDLE: connection not discarded'}`);
          if (key) pipelinedDeadlineErrors.set(key, error);
          if (discard) {
            try { discard(); } catch (discardError) { error.message += `; discard failed: ${discardError instanceof Error ? discardError.message : String(discardError)}`; }
          }
          reject(error);
        }, Math.max(0, absoluteDeadline - Date.now()));
      });
      try { results.push(await Promise.race([running, expired])); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return results;
  }
  const settled = await Promise.allSettled(calls.map(call => { try { return call(); } catch (error) { return Promise.reject(error); } }));
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  // A statement sent after the one that failed reports 25P02 (transaction aborted); the cause is the other one.
  const failed = rejected.find(s => (s.reason as { code?: unknown } | null)?.code !== '25P02') ?? rejected[0];
  if (failed) throw failed.reason;
  return settled.map(s => (s as PromiseFulfilledResult<unknown>).value);
}
