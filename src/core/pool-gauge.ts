/**
 * CheckoutGauge — approximate in-flight query counters for the health probe's
 * pool diagnostics (issue #6).
 *
 * HONESTY CONTRACT (read before extending): this gauge counts calls through
 * the engine's raw/direct/reserved/transaction seams ONLY. The majority of
 * engine traffic — tagged-template queries on `this.sql` (getConfig, CRUD,
 * search) — is NOT tracked; postgres.js exposes no public checkout counters
 * and proxying the Sql template function is too invasive for a diagnostic.
 * Every consumer must label these numbers as a tracked SUBSET and must never
 * derive "available" or "waiting" figures from them (that arithmetic is
 * invented telemetry — outside-voice review, codex-2 #3). The authoritative
 * starvation signal is the direct-lane disambiguation probe in
 * `src/core/minions/db-probe.ts`; these counts are supporting detail.
 *
 * Fail-open by construction: plain integer bumps, no I/O, release() clamps
 * at zero so a missed acquire can never underflow into negative counts.
 */

/** Which engine seam the in-flight call went through. */
export type GaugeKind = 'raw' | 'direct' | 'reserved' | 'tx';

export interface PoolGaugeSnapshot {
  /** executeRaw on the read pool. */
  raw: number;
  /** executeRawDirect (direct session lane when dual-pool, read pool otherwise). */
  direct: number;
  /** withReservedConnection holders. */
  reserved: number;
  /** transaction() bodies. */
  tx: number;
}

export class CheckoutGauge {
  private counts: PoolGaugeSnapshot = { raw: 0, direct: 0, reserved: 0, tx: 0 };
  private checkoutListeners = new Set<() => void>();

  /**
   * #5801: `listener` runs after a connection is actually obtained (reserve
   * resolution or transaction-callback entry), never when a call merely starts
   * waiting. Callers attribute the call to their own work (for example through
   * AsyncLocalStorage); the gauge itself knows nothing about callers.
   */
  onCheckout(listener: () => void): () => void {
    this.checkoutListeners.add(listener);
    return () => { this.checkoutListeners.delete(listener); };
  }

  checkedOut(): void {
    for (const listener of this.checkoutListeners) {
      try { listener(); } catch { /* best-effort */ }
    }
  }

  acquire(kind: GaugeKind): void {
    this.counts[kind] += 1;
  }

  release(kind: GaugeKind): void {
    if (this.counts[kind] > 0) this.counts[kind] -= 1;
  }

  snapshot(): PoolGaugeSnapshot {
    return { ...this.counts };
  }
}

/**
 * #5730: pooled connections the vendored driver terminated instead of reusing
 * because their ReadyForQuery status was not idle (`T` inside a transaction,
 * `E` inside a failed one). Each discard is counted once and logged as one
 * fixed-shape warn line; the status byte is the only driver-supplied value.
 */
export class PoisonedDiscardCounter {
  private discards = 0;

  get count(): number {
    return this.discards;
  }

  record(pool: 'read' | 'direct', status: string): void {
    this.discards += 1;
    try { console.warn(formatPoisonedDiscardWarning(pool, status)); } catch { /* best-effort */ }
  }
}

export function formatPoisonedDiscardWarning(pool: 'read' | 'direct', status: string): string {
  const byte = /^[A-Z]$/.test(status) ? status : '?';
  return `[gbrain] warn code=pg_connection_poisoned status=${byte} pool=${pool}` +
    ` cause="a connection came back to the pool inside a transaction; it was discarded and replaced"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-poisoned`;
}
