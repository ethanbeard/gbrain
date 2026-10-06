import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { formatManagedSyncBacklog, readManagedSyncBacklog } from '../../../core/persistence/sync-drain.ts';

const IDLE_MS = 60 * 60_000;

/** #5984: unfinished managed sync cursors, their remaining entries and ETA; warns when one has not advanced for an hour. */
export async function checkManagedSyncBacklog(engine: BrainEngine | null, sourceIds?: string[]): Promise<Check | null> {
  if (!engine) return null;
  const backlog = await readManagedSyncBacklog(engine, sourceIds);
  if (!backlog.length) return null;
  const idle = backlog.filter(b => !b.last_progress_at || Date.now() - Date.parse(b.last_progress_at) > IDLE_MS);
  const lines = backlog.map(formatManagedSyncBacklog).join('; ');
  return { name: 'managed_sync_backlog', status: idle.length ? 'warn' : 'ok',
    message: idle.length
      ? `${idle.length} managed sync cursor(s) have not advanced for over an hour. ${lines}. Run the resume command; it drains the backlog in one run (safe to rerun).`
      : `Managed sync catch-up in progress. ${lines}.` };
}
