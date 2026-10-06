/**
 * The resident consumer's stderr line is the only trace an operator gets when
 * a phase fails or overruns. #5233: the line carried only an error code, so a
 * pooler's "max clients reached" was invisible. It now carries a redacted,
 * one-line, length-capped message, a fix command and a docs anchor. #5801: it
 * also says whether the phase ever obtained a connection (first_conn_ms, or
 * checkout=not_observed with the time spent waiting) and the event-loop lag.
 *
 * Regression that fails it: dropping the message (or the redaction) from the
 * line, reporting a checkout that happened after the deadline or in another
 * caller's async chain, or omitting the timing fields. Existing coverage
 * asserts consumer state, not this line.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const stderr: string[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; stderr.length = 0; });

function captureStderr() {
  spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
}

function failingEngine(error: Error): BrainEngine {
  return new Proxy({ kind: 'pglite' } as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'then' || prop === 'onCheckout') return undefined;
      return async () => { throw error; };
    },
  }) as unknown as BrainEngine;
}

describe('persistence consumer stderr line', () => {
  test('#5233: carries the SQLSTATE and a redacted, capped, one-line message', async () => {
    const error = Object.assign(new Error(
      '(EMAXCONNSESSION) max clients reached in session mode\n - pool_size: 15 for postgresql://writer:secret-pw@pooler.example.com:5432/postgres '
        + 'x'.repeat(400)), { code: '53300' });
    captureStderr();
    const consumer = new PersistenceConsumer(failingEngine(error), { engine: 'pglite' }, async () => { throw error; }, { hostId: crypto.randomUUID() });
    try { await consumer.tick(); } finally { await consumer.stop(); }
    const line = stderr.find(entry => entry.startsWith('[persistence] phase='));
    expect(line).toBeDefined();
    expect(line).toContain('reason=53300');
    expect(line).toContain('message="(EMAXCONNSESSION) max clients reached in session mode - pool_size: 15 for ');
    expect(line).not.toContain('secret-pw');
    expect(line).toContain('fix: gbrain sources writer status --json');
    expect(line).toContain('docs: docs/ENGINES.md#persistence-consumer-log');
    const message = /message="([^"]*)"/.exec(line!)![1];
    expect(message.length).toBeLessThanOrEqual(200);
    expect(line!.trimEnd().includes('\n')).toBe(false);
  });
});

function delayedCheckoutEngine(checkoutAfterMs: number, failAfterMs: number, error: Error) {
  const listeners = new Set<() => void>();
  const call = async () => {
    await Bun.sleep(checkoutAfterMs);
    for (const listener of listeners) listener();
    await Bun.sleep(failAfterMs);
    throw error;
  };
  const target: Record<string, unknown> = {
    kind: 'postgres',
    onCheckout: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const engine = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      if (prop === 'then') return undefined;
      return call;
    },
  }) as unknown as BrainEngine;
  return { engine, unrelatedCheckout: () => { for (const listener of listeners) listener(); } };
}

describe('#5801 connection-wait evidence on the consumer line', () => {
  const failure = () => Object.assign(new Error('synthetic storage failure'), { code: '08006' });

  test('a checkout that arrives after the deadline is reported as not_observed with the time waited', async () => {
    const { engine } = delayedCheckoutEngine(200, 0, failure());
    captureStderr();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw failure(); }, { hostId: crypto.randomUUID(), phaseMs: 100 });
    try { await consumer.tick(); } finally { await consumer.stop(); }
    const line = stderr.find(entry => entry.includes('reason=deadline_exceeded'));
    expect(line).toBeDefined();
    expect(line).toContain('checkout=not_observed');
    expect(line).not.toContain('first_conn_ms=');
    expect(Number(/conn_wait_ms=(\d+)/.exec(line!)![1])).toBeGreaterThanOrEqual(100);
    expect(line).toMatch(/loop_lag_ms=\d+/);
  });

  test('a checkout inside the phase reports its real acquisition time', async () => {
    const { engine } = delayedCheckoutEngine(150, 50, failure());
    captureStderr();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw failure(); }, { hostId: crypto.randomUUID(), phaseMs: 2_000 });
    try { await consumer.tick(); } finally { await consumer.stop(); }
    const line = stderr.find(entry => entry.includes('reason=08006'));
    expect(line).toBeDefined();
    const firstConn = Number(/first_conn_ms=(\d+)/.exec(line!)![1]);
    expect(firstConn).toBeGreaterThanOrEqual(140);
    expect(firstConn).toBeLessThan(2_000);
    expect(line).not.toContain('checkout=not_observed');
  });

  test('an unrelated checkout outside the phase cannot satisfy its observation', async () => {
    const { engine, unrelatedCheckout } = delayedCheckoutEngine(300, 0, failure());
    captureStderr();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw failure(); }, { hostId: crypto.randomUUID(), phaseMs: 100 });
    const ticking = consumer.tick();
    await Bun.sleep(20);
    unrelatedCheckout();
    try { await ticking; } finally { await consumer.stop(); }
    const line = stderr.find(entry => entry.includes('reason=deadline_exceeded'));
    expect(line).toContain('checkout=not_observed');
    expect(line).not.toContain('first_conn_ms=');
  });
});
