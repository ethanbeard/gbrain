/**
 * Checkout-less extract phase (#5875).
 *
 * A cycle with no on-disk checkout (a connector source such as Google, or a
 * Postgres brain run without `--dir`) has no files to walk, but its pages can
 * still be stale for link/timeline extraction: connector publications write
 * pages without derived links. This runner drains that backlog from the
 * database with the same bounded, source-scoped `extractStaleFromDB` call the
 * file-backed extract phase runs after its walk. On a managed brain
 * `extractStaleFromDB` routes to `extractManagedStaleLinks`, the coordinated
 * extraction path, so no guarded table is written outside the coordinator.
 *
 * Scope: a per-source cycle drains only its source; a brain-wide cycle (no
 * source id) drains every source inside the same budget. Throws propagate to
 * the cycle's phase containment, which records a `fail` result.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { extractStaleFromDB } from '../../commands/extract.ts';

export async function runPhaseExtractDatabaseOnly(
  engine: BrainEngine,
  opts: { dryRun: boolean; sourceId?: string; timeBudgetMs: number },
): Promise<PhaseResult> {
  if (opts.dryRun) {
    return {
      phase: 'extract',
      status: 'skipped',
      duration_ms: 0,
      summary: 'dry-run: extract phase skipped (no dry-run mode yet)',
      details: { dryRun: true, reason: 'no_dry_run_support', database_only: true },
    };
  }
  const drained = await extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: false,
    quiet: true,
    sourceIdFilter: opts.sourceId,
    catchUp: false,
    timeBudgetMs: opts.timeBudgetMs,
  });
  return {
    phase: 'extract',
    status: 'ok',
    duration_ms: 0,
    summary: `${drained.linksCreated} link(s), ${drained.timelineCreated} timeline entries `
      + `(database-only: ${drained.pagesProcessed} stale page(s) drained, ${drained.staleRemaining} remaining)`,
    details: {
      database_only: true,
      linksCreated: drained.linksCreated,
      timelineCreated: drained.timelineCreated,
      pages_processed: 0,
      stale_pages_drained: drained.pagesProcessed,
      stale_links_created: drained.linksCreated,
      stale_timeline_created: drained.timelineCreated,
      staleRemaining: drained.staleRemaining,
      ...(drained.staleRemaining > 0 ? { stale_backlog: true } : {}),
    },
  };
}
