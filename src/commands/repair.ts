/**
 * `gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]`
 *
 * Host-side repairs for residual damage the doctor reports. Every kind is a
 * dry run unless `--apply` is passed; applying publishes each item through a
 * coordinated page write (or, for `safe-chunks`, a projection-only rebuild
 * that takes no admission), resumes after an interruption, and stops before
 * crossing 90% of a cumulative journal cap. Thin clients refuse (cli.ts).
 * Explicit-only kinds run only when named; `--all` and the no-kind preview
 * list them with their preview command instead, and only they accept
 * `--expect <hash>` and `--include-ambiguous` (their preview-bound apply).
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { clearHealthMemo } from '../core/health-memo.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { REPAIR_KINDS, resolveRepairScope, type RepairKind, type RepairResult } from '../core/repair/core.ts';
import { consentGate, engineConsentEnv } from '../core/consent-cli.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, REPAIR_REGISTRY, explicitRepairNotices, repairMaySpend, repairPreviewCommand, repairRunner, repairSpec } from '../core/repair/registry.ts';

function wrap(text: string, indent: number, width = 80): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent + line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}

const explicitKinds = EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind).join(', ');

export const REPAIR_HELP = `Usage: gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]
       gbrain repair --all [--apply] [--source <id>] [--json]
       gbrain repair <explicit-only kind> [--include-ambiguous] [--apply --expect <preview-hash>] [--source <id>] [--json]
       gbrain repair frontmatter [--source <id>] [--include-ambiguous] [--only <path>]... [--skip <path>]... [--diff]
                                 [--apply --expect <preview-hash> --yes] [--json]

Repair residual damage that \`gbrain doctor\` reports. Dry run unless --apply.

Kinds:
${REPAIR_REGISTRY.map(spec => `  ${spec.kind.length < 13 ? spec.kind.padEnd(12) : `${spec.kind}\n${' '.repeat(14)}`} ${wrap(`${spec.explicit_only
    ? `[explicit-only; preview: ${repairPreviewCommand(spec.kind)}] ` : ''}${spec.summary}`, 15)}`).join('\n')}

Options:
  --apply        Write the repair (no prompt). Without it, only preview.
  --source <id>  Limit to one source (default: every active source).
  --limit <n>    Repair at most n items; rerun the same command to continue.
  --no-embed     safe-chunks, contextual-mode: no provider call; embed later with gbrain embed --stale.
  --all          Run every kind in order (${AUTO_REPAIR_REGISTRY.map(spec => spec.kind).join(', ')}).
                 Explicit-only kinds (${explicitKinds}) never run here; name each one.
  --expect <hash>
                 Explicit-only kinds: apply exactly the set the preview printed under this hash.
  --include-ambiguous
                 Explicit-only kinds: widen the preview to ambiguous items (its hash covers them).
  --only <path>, --skip <path>
                 frontmatter: select source-relative files (repeatable); the hash covers the selection.
  --diff         frontmatter: print every per-file diff, not one sample per class.
  --yes          frontmatter --apply: the user agreed to the previewed file changes (destructive consent;
                 without it a terminal asks, and a non-interactive run exits 3 with the consent payload).
  --json         Machine-readable output with a stable shape (frontmatter: every per-file diff).

Any other option is refused. There is no --max-usd here: to cap paid embedding
work, preview gbrain doctor --remediation-plan --json and, after the user agrees, run
gbrain doctor --remediate --yes --include-repairs --max-usd <n> --expect <plan_hash>.
With no kind, previews every kind. Run it on the brain host.
Held files (two-pass frontmatter repair with real output): docs/guides/repair.md#held-files.`;

const BOOLEAN_FLAGS = new Set(['--apply', '--all', '--json', '--no-embed', '--include-ambiguous', '--diff', '--yes']);
const VALUE_FLAGS = new Set(['--source', '--limit', '--expect', '--only', '--skip']);
/** Flags only `gbrain repair frontmatter` accepts. */
const FRONTMATTER_FLAGS = ['--only', '--skip', '--diff', '--yes'] as const;
const VALUE_EXAMPLES: Record<string, string> = { '--source': 'default', '--limit': '50', '--expect': 'PLAN_HASH', '--only': 'notes/a.md', '--skip': 'notes/a.md' };
/** A usage refusal whose fix is the read-only preview (gbrain repair without --apply writes nothing). */
const invalid = (message: string, suggestion: string, preview: string[] = ['gbrain', 'repair', '--json']) => opError('invalid_params', message, suggestion,
  { fix: readFix('Previews the repair; without --apply it writes nothing.', { argv: preview }) });

interface RepairArgs { kind?: string; apply: boolean; all: boolean; json: boolean; noEmbed: boolean; includeAmbiguous: boolean; diff: boolean; yes: boolean;
  source?: string; limit?: string; expect?: string; only: string[]; skip: string[] }

/** Strict parse: every flag is known, value flags carry a value, at most one kind. */
export function parseRepairArgs(args: string[]): RepairArgs {
  const parsed: RepairArgs = { apply: false, all: false, json: false, noEmbed: false, includeAmbiguous: false, diff: false, yes: false, only: [], skip: [] };
  const used = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (FRONTMATTER_FLAGS.includes(flag as typeof FRONTMATTER_FLAGS[number])) used.add(flag);
    if (flag === '--max-usd' || flag === '--max-cost') {
      const cap = equal < 0 ? args[i + 1] : token.slice(equal + 1);
      throw new OperationError('invalid_params', `${flag} is not a gbrain repair option; the repair did not run.`,
        `To cap paid repair work, preview gbrain doctor --remediation-plan --json, then after the user agrees run: gbrain doctor --remediate --yes --include-repairs --max-usd ${cap && !cap.startsWith('-') ? cap : '<n>'} --expect <plan_hash> (plan_hash from the preview)`);
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equal >= 0) throw invalid(`${flag} does not accept a value.`, `Write ${flag} on its own, without =value; leave it out to keep it off.`);
      if (flag === '--apply') parsed.apply = true;
      else if (flag === '--all') parsed.all = true;
      else if (flag === '--json') parsed.json = true;
      else if (flag === '--include-ambiguous') parsed.includeAmbiguous = true;
      else if (flag === '--diff') parsed.diff = true;
      else if (flag === '--yes') parsed.yes = true;
      else parsed.noEmbed = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw invalid(`Unknown option ${flag} for gbrain repair.`, `Remove ${flag}; gbrain repair accepts ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(', ')}.`);
    const value = equal >= 0 ? token.slice(equal + 1) : args[++i];
    if (!value || value.startsWith('--')) throw invalid(`${flag} requires a value.`, `Give ${flag} its value right after it, e.g. ${flag} ${VALUE_EXAMPLES[flag]}${flag === '--expect' ? ' (the plan_hash the preview printed)' : ''}.`);
    if (flag === '--source') parsed.source = value;
    else if (flag === '--expect') parsed.expect = value;
    else if (flag === '--only') parsed.only.push(value);
    else if (flag === '--skip') parsed.skip.push(value);
    else parsed.limit = value;
  }
  if (positional.length > 1) throw new OperationError('invalid_params', `Unexpected argument '${positional[1]}'; gbrain repair takes at most one kind.`,
    `Kinds: ${REPAIR_KINDS.join(', ')}.`);
  parsed.kind = positional[0];
  if (used.has('--yes') && parsed.kind !== 'frontmatter') throw invalid('`--yes` is not accepted by gbrain repair; pass --apply to write.',
    `Preview first with gbrain repair${parsed.kind ? ` ${parsed.kind}` : ''}, then run the same command with --apply instead of --yes.`,
    ['gbrain', 'repair', ...(parsed.kind ? [parsed.kind] : []), ...(parsed.source ? ['--source', parsed.source] : []), '--json']);
  const frontmatterOnly = [...used].find(flag => flag !== '--yes');
  if (frontmatterOnly && parsed.kind !== 'frontmatter') throw new OperationError('invalid_params', `${frontmatterOnly} applies only to gbrain repair frontmatter.`,
    `Preview it by name: gbrain repair frontmatter${parsed.source ? ` --source ${parsed.source}` : ''}`);
  const bound = parsed.expect !== undefined ? '--expect' : parsed.includeAmbiguous ? '--include-ambiguous' : undefined;
  if (bound && !EXPLICIT_REPAIR_REGISTRY.some(spec => spec.kind === parsed.kind)) {
    throw new OperationError('invalid_params', `${bound} applies only to an explicit-only kind named on the command line (${explicitKinds}).`,
      `Preview one by name: ${repairPreviewCommand(EXPLICIT_REPAIR_REGISTRY[0]!.kind)}`);
  }
  return parsed;
}

function human(result: RepairResult, opts: { diff: boolean } = { diff: false }): string {
  const lines = [`${result.kind}: ${result.affected} item(s) ${result.mode === 'apply' ? 'pending before this run' : 'to repair'}`];
  for (const warning of result.warnings ?? []) lines.push(`  WARNING: ${warning}`);
  if (result.sample.length) lines.push(`  e.g. ${result.sample.join(', ')}`);
  const residuals = Object.entries(result.residuals).map(([k, v]) => `${k}=${v}`).join(', ');
  if (residuals) lines.push(`  ${residuals}`);
  lines.push(`  cost: ${result.cost.lifetime_ids} request ID(s), ${result.cost.receipt_bytes} receipt bytes, `
    + `${result.cost.embedding_pages} page(s) to re-embed${result.cost.embedding_usd === null ? '' : ` (~$${result.cost.embedding_usd.toFixed(4)})`}`);
  for (const c of result.capacity) lines.push(`  capacity ${c.scope} ${c.resource}: ${c.used} of ${c.limit} (stops at ${c.stop_at})`);
  if (result.resumed_from) lines.push(`  resuming after item ${result.resumed_from.phase}:${result.resumed_from.id}`);
  if (result.mode === 'apply') lines.push(`  applied ${result.applied}, skipped ${result.skipped}${result.complete ? ', complete' : ''}`);
  if (result.stopped) lines.push(`  STOPPED: ${result.stopped.message}`);
  for (const entry of result.listing ?? []) lines.push(`  ${entry.class}: ${entry.item}${entry.detail ? ` (${entry.detail})` : ''}`);
  const render = repairSpec(result.kind).handler.render;
  if (result.details && render) lines.push(...render(result.details, opts));
  if (result.mode === 'apply' && result.outcomes) lines.push(`  outcomes: ${Object.entries(result.outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  for (const outcome of result.mode === 'apply' ? result.outcome_items ?? [] : []) {
    if (!outcome.detail) continue;
    lines.push(`  ${outcome.outcome}: ${outcome.item} ${Object.entries(outcome.detail).filter(([key]) => key !== 'commit_step').map(([k, v]) => `${k}=${v}`).join(', ')}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    if (typeof outcome.detail.commit_step === 'string') lines.push(`    commit: ${outcome.detail.commit_step}`);
  }
  if (result.mode === 'dry_run' && result.affected) lines.push(`  apply: ${result.apply_command}`);
  return lines.join('\n');
}

export async function runRepairCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REPAIR_HELP); return; }
  const { kind, apply, all, json, noEmbed, includeAmbiguous, source, expect, only, skip, diff, limit: limitText } = parseRepairArgs(args);
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw invalid('--limit must be a positive integer.', 'Pass --limit as a positive whole number, e.g. --limit 50, or omit it to repair every item.');
  if (kind && !REPAIR_KINDS.includes(kind as RepairKind)) {
    throw new OperationError('invalid_params', `Unknown repair kind '${kind}'.`, `Kinds: ${REPAIR_KINDS.join(', ')}.`);
  }
  if (kind && all) throw invalid('Pass either a kind or --all, not both.', `Drop --all to repair only ${kind}, or drop ${kind} to run every automatic kind.`,
    ['gbrain', 'repair', kind, ...(source ? ['--source', source] : []), '--json']);
  if (!kind && apply && !all) throw invalid('Name a kind or pass --all with --apply.',
    'Review the preview of every automatic kind, then apply one by name (gbrain repair KIND --apply) or all of them with --all --apply.',
    ['gbrain', 'repair', ...(source ? ['--source', source] : []), '--json']);
  const kinds: RepairKind[] = kind ? [kind as RepairKind] : AUTO_REPAIR_REGISTRY.map(spec => spec.kind);
  const explicitKindsNotRun = kind ? [] : explicitRepairNotices({ source });
  const scope = await resolveRepairScope(engine, source);
  if (apply && kind && expect && repairSpec(kind as RepairKind).consent === 'destructive') {
    const preview = ['gbrain', 'repair', kind, ...(source ? ['--source', source] : []), ...only.flatMap(path => ['--only', path]), ...skip.flatMap(path => ['--skip', path]),
      ...(includeAmbiguous ? ['--include-ambiguous'] : [])];
    const auth = await consentGate({ command: `repair ${kind}`, effects: ['destructive'], actor: 'agent',
      what: `Rewrite the previewed ${kind} changes on disk and import them`,
      why: `The preview ${expect} listed each file change; applying it rewrites those files in place and publishes them.`,
      risk: 'Only the previewed lines change; a file that changed since the preview is skipped. Managed sources commit through the Git effect (undo with git revert); legacy sources keep a backup under ~/.gbrain/backups/frontmatter/.',
      user_message: `Apply the previewed ${kind} repair (preview ${expect.slice(0, 12)})? Each listed file is rewritten on disk exactly as the preview showed and imported again.`,
      argv: [...preview, '--apply', '--expect', expect, ...(json ? ['--json'] : [])], preview_argv: [...preview, '--json'], plan_hash: expect, args }, { json, env: engineConsentEnv(engine) });
    if (!auth) return;
  }
  const runner = await repairRunner(engine, { apply, noEmbed });
  const results: Array<RepairResult & { paid: boolean }> = [];
  for (const k of kinds) {
    const result = await runner.run(k, scope, { limit, sourceFlag: source, explicit: k === kind, expect, includeAmbiguous, ...(k === 'frontmatter' ? { only, skip } : {}) });
    results.push({ ...result, paid: repairMaySpend(repairSpec(k), noEmbed) });
    if (result.stopped) break;
  }
  if (apply) clearHealthMemo(engine);
  const paidKinds = results.filter(r => r.paid).map(r => r.kind);
  if (json) {
    console.log(JSON.stringify({ scope, mode: apply ? 'apply' : 'dry_run', results, paid_kinds: paidKinds,
      ...(explicitKindsNotRun.length ? { explicit_kinds: explicitKindsNotRun } : {}) }, null, 2));
  } else {
    console.log(`Scope: brain ${scope.brain_id}; sources ${scope.source_ids.join(', ') || '(none)'}`);
    for (const result of results) console.log(human(result, { diff }));
    if (!apply && paidKinds.length) console.log(`Kinds that may queue paid embeddings: ${paidKinds.join(', ')} (pass --no-embed to skip; `
      + 'page-write kinds are re-embedded by their publication either way; cap spend with gbrain doctor --remediate --yes --include-repairs --max-usd <n> --expect <plan_hash> from gbrain doctor --remediation-plan --json).');
    if (explicitKindsNotRun.length) console.log(`Explicit-only kinds (not run without their name; preview each): ${explicitKindsNotRun.map(n => n.preview_command).join('; ')}`);
  }
  if (results.some(r => r.stopped)) setCliExitVerdict(1);
}
