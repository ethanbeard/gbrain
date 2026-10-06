import type { BrainEngine } from '../engine.ts';
import { validateSlug } from '../utils.ts';
import type { PageKey } from './types.ts';

/** Source locks precede auth/request locks in callers; repeat held locks safely. */
export async function lockPageKeys(engine: Pick<BrainEngine, 'executeRaw'>, keys: readonly PageKey[]): Promise<void> {
  const unique = new Map<string, PageKey>();
  for (const key of keys) {
    if (!key.sourceId) throw new TypeError('A page guard requires an exact sourceId');
    const slug = validateSlug(key.slug);
    unique.set(JSON.stringify([key.sourceId, slug]), { sourceId: key.sourceId, slug });
  }
  const ordered = [...unique.values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const sources = new Map<string, string>();
  for (const { sourceId } of ordered) {
    if (sources.has(sourceId)) continue;
    const rows = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!rows.length) throw new Error(`Page source does not exist: ${sourceId}`);
    sources.set(sourceId, rows[0].incarnation);
  }
  if (ordered.length > 1) {
    // #5984: many keys in three statements, still created and locked in the sorted key order.
    const incarnations = ordered.map(key => sources.get(key.sourceId)!), slugs = ordered.map(key => key.slug), sourceIds = ordered.map(key => key.sourceId);
    await engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) SELECT i,s FROM unnest($1::uuid[],$2::text[]) WITH ORDINALITY AS k(i,s,n) ORDER BY n ON CONFLICT DO NOTHING', [incarnations, slugs]);
    await engine.executeRaw(`SELECT g.slug FROM unnest($1::uuid[],$2::text[]) WITH ORDINALITY AS k(i,s,n)
      JOIN page_write_guards g ON g.source_incarnation=k.i AND g.slug=k.s ORDER BY k.n FOR UPDATE OF g`, [incarnations, slugs]);
    await engine.executeRaw(`SELECT p.id FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS k(src,s,n)
      JOIN pages p ON p.source_id=k.src AND p.slug=k.s ORDER BY k.n FOR UPDATE OF p`, [sourceIds, slugs]);
    return;
  }
  for (const key of ordered) {
    const params = [sources.get(key.sourceId)!, key.slug];
    await engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', params);
    await engine.executeRaw('SELECT slug FROM page_write_guards WHERE source_incarnation=$1::uuid AND slug=$2 FOR UPDATE', params);
    // Also fence direct SQL row writers. The guard remains when this row is absent.
    await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [key.sourceId, key.slug]);
  }
}

/**
 * Guards a transaction already holds, chained through its open savepoints.
 * The transaction's session owns them until the transaction or savepoint
 * ends, so they are not re-acquired. That includes a key whose pages row was
 * absent when it was locked: the only pages INSERT (engine-sql/pages.ts
 * putPage) runs after both engines' putPage take the same guard.
 */
export interface HeldPageKeys { keys: Set<string>; parent: HeldPageKeys | null }
function pageGuardKey(key: PageKey): string | null {
  if (!key.sourceId) return null;
  try { return JSON.stringify([key.sourceId, validateSlug(key.slug)]); } catch { return null; }
}
function holds(held: HeldPageKeys | null, id: string): boolean {
  for (; held; held = held.parent) if (held.keys.has(id)) return true;
  return false;
}
/** lockPageKeys for keys this transaction does not hold yet; invalid keys still reach its checks. */
export async function lockUnheldPageKeys(engine: Pick<BrainEngine, 'executeRaw'>, held: HeldPageKeys, keys: readonly PageKey[]): Promise<void> {
  const pending = keys.filter(key => { const id = pageGuardKey(key); return id === null || !holds(held, id); });
  if (!pending.length) return;
  await lockPageKeys(engine, pending);
  for (const key of pending) held.keys.add(pageGuardKey(key)!);
}
/** Runs a transaction or savepoint; a released savepoint's guards stay held by its parent, a rolled-back one's do not. */
export async function withHeldPageKeys<T>(parent: HeldPageKeys | null, run: (held: HeldPageKeys) => Promise<T>): Promise<T> {
  const held: HeldPageKeys = { keys: new Set(), parent };
  const result = await run(held);
  for (const key of held.keys) parent?.keys.add(key);
  return result;
}
