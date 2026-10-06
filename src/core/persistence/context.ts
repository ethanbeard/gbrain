import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import type { WriteAttribution } from './attribution.ts';

interface PublicationContext { brainId: string; sourceIds: ReadonlySet<string>; active: boolean; }
const publication = new AsyncLocalStorage<PublicationContext>();
const ATTRIBUTION_SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'] as const;

/**
 * Sets transaction-local settings around `fn` in one round trip each way. An
 * aborted transaction cannot accept statements; its rollback clears SET LOCAL
 * automatically. A success restores the enclosing values.
 */
async function withTransactionSettings<T>(engine: Pick<BrainEngine, 'executeRaw'>, names: readonly string[],
  next: (previous: string[]) => string[], fn: () => Promise<T>): Promise<T> {
  const [row] = await engine.executeRaw<Record<string, string | null>>(
    `SELECT ${names.map((name, index) => `current_setting('${name}',true) AS s${index}`).join(',')}`);
  const previous = names.map((_, index) => row?.[`s${index}`] ?? '');
  await applySettings(engine, names, next(previous));
  let failed = false;
  try { return await fn(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await applySettings(engine, names, previous); }
    catch (error) { if (!failed) throw error; }
  }
}
function applySettings(engine: Pick<BrainEngine, 'executeRaw'>, names: readonly string[], values: string[]) {
  return engine.executeRaw(`SELECT ${names.map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`, values);
}
/** A nested scope keeps the outer actor: a request publication that calls a derived writer stays attributed to the request. */
const attributionValues = (outer: string[], attribution: WriteAttribution) => outer[1]
  ? outer : [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id];

/**
 * Only the coordinator and guarded projection workers establish this execution
 * capability. `attribution` names the actor the database stamps on every
 * content row and page revision written inside (persistence/attribution-schema.ts).
 */
export async function withCoordinatedWrite<T>(engine: BrainEngine, sourceIds: string[], fn: () => Promise<T>, attribution: WriteAttribution): Promise<T> {
  // #6007: the persistence identity, the enclosing settings and the new settings in one round trip;
  // nothing is set when the identity row is missing. The OFFSET 0 subquery reads the enclosing values first.
  const names = ['gbrain.write_sources', ...ATTRIBUTION_SETTINGS];
  const [brain] = await engine.executeRaw<Record<string, string | null>>(`SELECT b.brain_id,prev.*,
      CASE WHEN b.brain_id IS NOT NULL THEN concat(set_config('gbrain.write_sources',$1,true),
        set_config('gbrain.write_request',CASE WHEN prev.s2<>'' THEN prev.s1 ELSE $2 END,true),
        set_config('gbrain.write_principal_kind',CASE WHEN prev.s2<>'' THEN prev.s2 ELSE $3 END,true),
        set_config('gbrain.write_principal_id',CASE WHEN prev.s2<>'' THEN prev.s3 ELSE $4 END,true)) END AS applied
    FROM (SELECT ${names.map((name, index) => `COALESCE(current_setting('${name}',true),'') AS s${index}`).join(',')} OFFSET 0) prev
    LEFT JOIN persistence_brain b ON b.singleton=1`,
  [JSON.stringify(sourceIds), attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id]);
  if (!brain?.brain_id) {
    throw opError('writer_not_initialized', 'Persistence identity is missing.',
      'This brain has no persistence identity row, so coordinated writes cannot run and nothing was written. List the pending migrations that create it and ask the user to approve applying them.',
      { fix: { argv: ['gbrain', 'apply-migrations', '--dry-run', '--json'], consent: [], actor: 'agent', why: 'Lists the pending migrations without applying them.', requires_exclusive: false } });
  }
  const context: PublicationContext = { brainId: brain.brain_id, sourceIds: new Set(sourceIds), active: true };
  const previous = names.map((_, index) => brain[`s${index}`] ?? '');
  let failed = false;
  try {
    return await publication.run(context, async () => {
      try { return await fn(); }
      finally { context.active = false; }
    });
  } catch (error) { failed = true; throw error; }
  finally {
    try { await applySettings(engine, names, previous); }
    catch (error) { if (!failed) throw error; }
  }
}
/**
 * #5984 bulk: inside one coordinated write that publishes several requests,
 * names the next request as the actor of the rows it writes. One statement; the
 * enclosing coordinated write restores the outer values when it ends.
 */
export async function setMemberAttribution(engine: Pick<BrainEngine, 'executeRaw'>, attribution: WriteAttribution): Promise<void> {
  await engine.executeRaw(`SELECT ${ATTRIBUTION_SETTINGS.map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`,
    [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id]);
}
/** Attribution without coordinator capability, for unmanaged legacy transactions. */
export function withWriteAttribution<T>(engine: Pick<BrainEngine, 'executeRaw'>, attribution: WriteAttribution, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, ATTRIBUTION_SETTINGS, outer => attributionValues(outer, attribution), fn);
}
export async function assertCoordinatedWrite(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return;
  const held = publication.getStore();
  if (!held?.active || held.brainId !== brain.brain_id || !held.sourceIds.has(sourceId)) {
    throw new OperationError('writer_coordinator_required', 'This writer must enter the canonical persistence coordinator.',
      'Use supported page operations, or drain managed writers before running this maintenance command.');
  }
}
