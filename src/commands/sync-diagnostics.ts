import type { SyncResult } from './sync.ts';
import type { GitHoldItem } from '../core/persistence/sync-holds.ts';

const HOLD_LINES = 20;

export function holdLine(item: GitHoldItem, verb: string): string {
  const where = [item.line !== undefined ? `line ${item.line}` : '', item.key ? `key "${item.key}"` : ''].filter(Boolean).join(', ');
  const page = item.stale ? 'its page keeps its last good revision and is read-only for put_page until the file is repaired' : 'its page is missing until the file imports';
  return `  ${verb} ${item.path}: ${item.code}${item.reason ? ` (${item.reason})` : ''}${where ? ` at ${where}` : ''}; ${page}. Next: ${item.fix.argv?.join(' ') ?? item.fix.why} (${item.docs})`;
}

/**
 * #5988: new holds this run (capped) and the outstanding total with the
 * inspect and repair commands. Every sync output mode prints it, including
 * resumed, no-change and `sync --all` runs on otherwise green sources.
 */
export function printHoldNotes(result: SyncResult, write: (line: string) => void): void {
  if (result.would_hold_count) {
    for (const item of (result.would_hold ?? []).slice(0, HOLD_LINES)) write(holdLine(item, 'Would hold'));
    if (result.would_hold_count > HOLD_LINES) write(`  ... and ${result.would_hold_count - HOLD_LINES} more would be held (--json lists them).`);
  }
  for (const skipped of (result.screen_skipped ?? []).slice(0, HOLD_LINES)) write(`  Screen skipped ${skipped.path}: ${skipped.code} (not a content problem; the real sync reports it).`);
  for (const item of (result.held ?? []).slice(0, HOLD_LINES)) write(holdLine(item, 'Held'));
  const shown = Math.min(result.held?.length ?? 0, HOLD_LINES);
  if ((result.held_count ?? 0) > shown) write(`  ... and ${(result.held_count ?? 0) - shown} more held this run (--json lists ${result.holds_truncated ? 'the first ones' : 'them all'}).`);
  const fix = result.holds_fix;
  if (fix) write(`  ${result.holds_escalated ? 'HOLDS ESCALATED: ' : ''}${fix.user_message ?? `${fix.why} Preview the repair: ${fix.argv!.join(' ')}`}`);
  if (result.converted_from_failed?.length) write(`  Converted ${result.converted_from_failed.length} failed request(s) of the blocked cursor in place: ${result.converted_from_failed.join(', ')}.`);
  const recovered = result.recovered_frontmatter?.fix;
  if (recovered) write(`  ${recovered.why} Preview: ${recovered.argv!.join(' ')}`);
}

export function printManagedSyncDiagnostic(result: SyncResult, sink: NodeJS.WriteStream): boolean {
  const d = result.managedWrite;
  if (!d) return false;
  const write = (line: string) => sink.write(line + '\n');
  write(result.status === 'blocked_by_failures'
    ? `Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed.`
    : 'Sync PARTIAL: an accepted write is not committed; last_commit is unchanged.');
  write(`  ${d.write_error} [${d.reason}]: ${d.message}`);
  write(`  Source: ${JSON.stringify(d.source_id)}; slug: ${JSON.stringify(d.slug)}; path: ${JSON.stringify(d.path)}`);
  write(`  Request: ${d.write_request.request_id} (${d.write_request.state})`);
  write(`  Fix: ${d.suggestion}`);
  if (d.docs) write(`  Docs: ${d.docs}`);
  if (d.ledger_recorded === false) write('  Local failure ledger unavailable; the durable receipt above remains authoritative.');
  return true;
}

/** Informational managed-sync lines: skipped slug collisions, refused files and the links derived after the checkpoint. */
export function printManagedSyncNotes(result: SyncResult, write: (line: string) => void): void {
  printHoldNotes(result, write);
  for (const collision of result.slugCollisions ?? []) {
    write(`  Slug collision: ${collision.skipped.join(', ')} and ${collision.kept} map to ${collision.slug}; kept ${collision.kept}. Rename one file to import both.`);
  }
  for (const refusal of result.fileRefusals ?? []) {
    write(`  Refused ${refusal.code}: ${refusal.message} ${refusal.suggestion} (${refusal.docs})`);
  }
  const skips = result.legacySkips;
  if (skips?.contextualMode) write(`  ${skips.contextualMode} legacy file(s) skipped because they parse to the same page but have no contextual retrieval mode, which a skipped import cannot stamp; to stamp it: gbrain repair contextual-mode`);
  if (skips?.canonicalBytes) write(`  ${skips.canonicalBytes} legacy file(s) skipped because they parse to the same page but their bytes are not what gbrain reads back (for example, not valid UTF-8); re-save them as UTF-8 to publish them exactly.`);
  const links = result.links;
  if (links && (links.created || links.removed || links.remaining)) {
    write(`  Links: ${links.created} created, ${links.removed} removed across ${links.pages} page(s)` +
      (links.remaining ? `; ${links.remaining} page(s) still owe extraction — run 'gbrain extract --stale'.` : '.'));
  }
}
