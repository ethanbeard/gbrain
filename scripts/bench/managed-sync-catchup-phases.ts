/**
 * Trace analysis for scripts/bench/managed-sync-catchup.ts: sequential round
 * trips (waves), transactions, the sync process's per-phase critical path, the
 * group publication breakdown with its counter hold, and per-put_page
 * foreground round trips. Pure functions over trace records, so
 * `--analyze <trace.jsonl>` reruns them on a kept trace without a database.
 *
 * Only statement prefixes that stay stable across the publication rewrite are
 * matched (RULES lists each segmentation rule; the JSON carries it too).
 */
import { classify, family, flatSql, pct, round1, sum, type TraceRecord } from './managed-sync-catchup-lib.ts';

export const RULES = {
  wave: 'A wave is a maximal run of records on one (pid, conn) whose [t, t+ms] intervals overlap; a describe record is always its own wave and the record after it starts a new one. Statements are execute and simple records; describes and connects count only as round trips.',
  transaction: 'Records between begin and commit/rollback on one (pid, conn). publication = has the lock_timeout 1s set_config and the counter lock (INSERT INTO persistence_counters(key)); group publication = also has >= 1 member attribution (SELECT set_config(\'gbrain.write_request\',...)); admission = INSERT INTO persistence_requests; claim = UPDATE persistence_requests [r] SET state=\'running\' (head claim and group follower claim are separate occurrences); cursor = INSERT/UPDATE/DELETE op_checkpoints.',
  freeze: 'Per admission: sync-process statements outside any phase transaction from the end of the first cursor save after max(previous admission end, last publication commit) up to the admission begin; waits and consumer background excluded. Wall excludes the cursor saves nested in the window.',
  prepare: 'Per publication: statements outside any phase transaction between the end of the last claim since the previous publication and the publication begin (waits and consumer background excluded).',
  wait: 'Per admission: WRITE_PROGRESS_SQL and SELECT * FROM persistence_requests WHERE id=$1::uuid / id=ANY($1::uuid[]) reads from the admission commit to the next cursor save (or admission). Its wall overlaps claim, prepare and publication.',
  commit_gap: 'Between consecutive committed group publications of one sync process (all publications when it published no group): wall, and every record the process sent in between. Single publications include foreground writes the sync process\'s consumer published.',
  member_chain: 'Members are split at their attribution statements (with its describe, if any): segment i runs from member i\'s attribution to member i+1\'s, so it holds member i\'s apply/effects tail and member i+1\'s authorize/snapshot/validate lead. The rotation leaves the steady per-member total unchanged. Steady = segments 2..n-1 of transactions with >= 3 members; segment 1 carries first-use describes, the last one runs into the counter lock and is part of the fixed cost.',
  counter_hold: 'From the counter row lock (SELECT * FROM persistence_counters ... FOR UPDATE, with its describe) to the commit, inclusive. INSERT INTO persistence_counters(key) ... ON CONFLICT DO NOTHING creates missing rows and locks no existing one, so it is outside the hold.',
};

const SIG = {
  lock1s: /^SELECT set_config\('synchronous_commit','on',true\),set_config\('lock_timeout','1s',true\)/,
  counterLock: /^INSERT INTO persistence_counters\(key\)/,
  counterRowLock: /^SELECT \* FROM persistence_counters WHERE key=ANY\(.*FOR UPDATE$/,
  attribution: /^SELECT set_config\('gbrain\.write_request',/,
  admission: /^INSERT INTO persistence_requests\b/,
  claim: /^UPDATE persistence_requests (?:r )?SET state='running'/,
  claimAttempt: /^SELECT r\.\* FROM persistence_requests r LEFT JOIN persistence_worktrees w/,
  cursor: /^(?:INSERT INTO|UPDATE|DELETE FROM) op_checkpoints\b/,
  wait: /^SELECT (?:\*|state,error_code,error_message,completed_at,updated_at,blocked_reason,outcome) FROM persistence_requests WHERE id=(?:\$1::uuid|ANY\(\$1::uuid\[\]\))$/,
};
const BEGIN = /^(?:begin|start transaction)\b/i;
const END = /^(?:commit|end)\b|^rollback(?!\s+to\b)/i;
const SYNC_FAMILIES = new Set(['cli-sync', 'reentry']);
const WAVE_EPS_MS = 0.005;

const end = (r: TraceRecord) => r.t + r.ms;
const byStart = (a: TraceRecord, b: TraceRecord) => a.t - b.t || end(a) - end(b);
const isStatement = (r: TraceRecord) => r.kind === 'execute' || r.kind === 'simple';
const is = (re: RegExp) => (r: TraceRecord) => re.test(flatSql(r.sql));

function groupBy<T>(xs: T[], key: (x: T) => string | number): Map<string | number, T[]> {
  const out = new Map<string | number, T[]>();
  for (const x of xs) { const k = key(x); const list = out.get(k); if (list) list.push(x); else out.set(k, [x]); }
  return out;
}

/** Waves and the summed span of their merged intervals. */
export function waves(records: TraceRecord[]): { count: number; spanMs: number } {
  let count = 0, spanMs = 0;
  for (const rs of groupBy(records, r => `${r.pid}:${r.conn}`).values()) {
    rs.sort(byStart);
    let open = false, start = 0, stop = 0, describe = false;
    for (const r of rs) {
      const d = r.kind === 'describe';
      if (!open || d || describe || r.t >= stop - WAVE_EPS_MS) {
        if (open) spanMs += stop - start;
        count++; open = true; start = r.t; stop = end(r); describe = d;
      } else stop = Math.max(stop, end(r));
    }
    if (open) spanMs += stop - start;
  }
  return { count, spanMs };
}

export interface Cost { statements: number; waves: number; describes: number }
export function cost(records: TraceRecord[]): Cost {
  return { statements: records.filter(isStatement).length, waves: waves(records).count, describes: records.filter(r => r.kind === 'describe').length };
}

export type TxnType = 'publication' | 'admission' | 'claim' | 'claim-attempt' | 'cursor' | 'other';
export interface Txn { pid: number; label: string; records: TraceRecord[]; start: number; end: number; type: TxnType; committed: boolean; members: number }

function txnType(records: TraceRecord[]): TxnType {
  const has = (re: RegExp) => records.some(r => re.test(flatSql(r.sql)));
  if (has(SIG.lock1s) && has(SIG.counterLock)) return 'publication';
  if (has(SIG.admission)) return 'admission';
  if (has(SIG.claim)) return 'claim';
  if (has(SIG.cursor)) return 'cursor';
  if (has(SIG.claimAttempt)) return 'claim-attempt';
  return 'other';
}

/** Transactions per (pid, conn), and the records outside any transaction. */
export function transactions(records: TraceRecord[]): { txns: Txn[]; loose: TraceRecord[] } {
  const txns: Txn[] = [];
  const loose: TraceRecord[] = [];
  const close = (rs: TraceRecord[], committed: boolean) => {
    const last = rs.at(-1)!;
    txns.push({ pid: rs[0]!.pid, label: rs[0]!.label, records: rs, start: rs[0]!.t, end: end(last), type: txnType(rs), committed,
      members: rs.filter(r => isStatement(r) && SIG.attribution.test(flatSql(r.sql))).length });
  };
  for (const rs of groupBy(records, r => `${r.pid}:${r.conn}`).values()) {
    rs.sort(byStart);
    let open: TraceRecord[] | null = null;
    for (const r of rs) {
      const sql = isStatement(r) ? r.sql.trim() : '';
      if (BEGIN.test(sql)) { if (open) close(open, false); open = [r]; continue; }
      if (!open) { loose.push(r); continue; }
      open.push(r);
      if (END.test(sql)) { close(open, /^(?:commit|end)\b/i.test(sql) && !r.err && !open.some(x => x.err)); open = null; }
    }
    if (open) close(open, false);
  }
  txns.sort((a, b) => a.start - b.start);
  return { txns, loose: loose.sort(byStart) };
}

function inWindow(records: TraceRecord[], from: number, to: number): TraceRecord[] {
  return records.filter(r => r.t >= from && r.t < to);
}

interface Occurrence { wall: number | null; records: TraceRecord[] }
export interface PhaseRow { phase: string; occurrences: number; wall_ms_total: number | null; wall_ms_p50: number | null; statements: number; statements_p50: number | null;
  waves: number; waves_p50: number | null; describes: number; statements_per_page: number | null; waves_per_page: number | null; concurrent: boolean }

function phaseRow(phase: string, occ: Occurrence[], pages: number | null, concurrent = false): PhaseRow {
  const costs = occ.map(o => cost(o.records));
  const walls = occ.flatMap(o => o.wall === null ? [] : [o.wall]);
  const statements = sum(costs.map(c => c.statements)), w = sum(costs.map(c => c.waves));
  return { phase, occurrences: occ.length, wall_ms_total: walls.length ? round1(sum(walls)) : null, wall_ms_p50: pct(walls, 50),
    statements, statements_p50: pct(costs.map(c => c.statements), 50), waves: w, waves_p50: pct(costs.map(c => c.waves), 50),
    describes: sum(costs.map(c => c.describes)), statements_per_page: pages ? round1(statements / pages) : null, waves_per_page: pages ? round1(w / pages) : null, concurrent };
}

/**
 * Pages a trace published, for `--analyze`: members of committed group
 * publications; without groups, committed single publications outside the
 * foreground writer (a sync consumer's singles can be foreground writes, so
 * singles are not added to groups).
 */
export function publishedPages(records: TraceRecord[]): number {
  const pubs = [...groupBy(records, r => r.pid).values()].flatMap(rs => transactions(rs).txns.filter(t => t.type === 'publication' && t.committed));
  return sum(pubs.map(t => t.members)) || pubs.filter(t => family(t.label) !== 'foreground').length;
}

/** Per-phase critical path of the sync processes (`cli-sync`, `reentry`); RULES describes each phase. */
export function criticalPath(records: TraceRecord[], pages: number | null): Record<string, unknown> {
  const occ: Record<string, Occurrence[]> = { 'publication (group)': [], 'publication (single)': [], freeze: [], admission: [], cursor: [], claim: [], prepare: [], wait: [], commit_gap: [], background: [] };
  const sync = records.filter(r => SYNC_FAMILIES.has(family(r.label)));
  for (const rs of groupBy(sync, r => r.pid).values()) {
    rs.sort(byStart);
    const { txns, loose } = transactions(rs);
    const of = (type: TxnType) => txns.filter(t => t.type === type);
    const pubs = of('publication'), adms = of('admission'), claims = of('claim'), cursors = of('cursor');
    const groups = pubs.filter(p => p.members > 0);
    for (const [phase, list] of [['publication (group)', groups], ['publication (single)', pubs.filter(p => !p.members)], ['admission', adms], ['claim', claims], ['cursor', cursors]] as const) {
      occ[phase]!.push(...list.map(t => ({ wall: t.end - t.start, records: t.records })));
    }
    const waits = loose.filter(is(SIG.wait));
    const background = [...loose.filter(r => !SIG.wait.test(flatSql(r.sql)) && classify(r.sql) === 'consumer-background'), ...of('claim-attempt').flatMap(t => t.records)];
    const free = [...loose.filter(r => !SIG.wait.test(flatSql(r.sql)) && classify(r.sql) !== 'consumer-background'), ...of('other').flatMap(t => t.records)].sort(byStart);
    occ.background!.push({ wall: null, records: background });
    for (const [k, p] of pubs.entries()) {
      const after = k ? pubs[k - 1]!.end : -Infinity;
      const claim = claims.filter(c => c.end <= p.start && c.end > after).at(-1);
      if (claim) occ.prepare!.push({ wall: p.start - claim.end, records: inWindow(free, claim.end, p.start) });
    }
    const last = end(rs.reduce((a, b) => end(a) > end(b) ? a : b));
    for (const [k, a] of adms.entries()) {
      const lastPub = pubs.filter(p => p.end <= a.start).at(-1);
      const base = Math.max(k ? adms[k - 1]!.end : rs[0]!.t, lastPub?.end ?? -Infinity);
      const firstSave = cursors.find(c => c.start >= base && c.end <= a.start);
      const from = firstSave ? firstSave.end : base;
      const nested = cursors.filter(c => c.start >= from && c.end <= a.start);
      occ.freeze!.push({ wall: a.start - from - sum(nested.map(c => c.end - c.start)), records: inWindow(free, from, a.start) });
      const next = Math.min(cursors.find(c => c.start >= a.end)?.start ?? Infinity, adms[k + 1]?.start ?? Infinity, last);
      occ.wait!.push({ wall: next - a.end, records: inWindow(waits, a.end, next) });
    }
    const ends = (groups.length ? groups : pubs).filter(p => p.committed).map(p => p.end);
    for (let i = 1; i < ends.length; i++) occ.commit_gap!.push({ wall: ends[i]! - ends[i - 1]!, records: rs.filter(r => r.t > ends[i - 1]! && r.t <= ends[i]!) });
  }
  const phases = Object.entries(occ).map(([phase, list]) => phaseRow(phase, list, pages, phase === 'wait' || phase === 'background'));
  const all = waves(sync);
  const pub = phases.find(p => p.phase === 'publication (group)')!;
  return { pages, processes: new Set(sync.map(r => r.pid)).size, phases,
    wave_check: { sync_waves: all.count, sync_statements: sync.filter(isStatement).length, ms_per_wave: all.count ? round1(all.spanMs / all.count) : null,
      publication_wall_ms_per_wave: pub.waves && pub.wall_ms_total !== null ? round1(pub.wall_ms_total / pub.waves) : null },
    rules: { wave: RULES.wave, transaction: RULES.transaction, freeze: RULES.freeze, prepare: RULES.prepare, wait: RULES.wait, commit_gap: RULES.commit_gap } };
}

interface Fit { fixed: number; per_member: number; r2: number | null; n: number }
function ols(xs: number[], ys: number[]): Fit | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = sum(xs) / n, my = sum(ys) / n;
  const sxx = sum(xs.map(x => (x - mx) ** 2));
  if (sxx === 0) return null;
  const b = sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / sxx;
  const a = my - b * mx;
  const sst = sum(ys.map(y => (y - my) ** 2)), sse = sum(ys.map((y, i) => (y - a - b * xs[i]!) ** 2));
  return { fixed: round1(a), per_member: Math.round(b * 100) / 100, r2: sst ? Math.round((1 - sse / sst) * 1000) / 1000 : null, n };
}
const mean = (xs: number[]) => xs.length ? round1(sum(xs) / xs.length) : null;

interface GroupTxn { process: string; members: number; statements: number; waves: number; describes: number; wall_ms: number; committed: boolean;
  hold: Cost & { ms: number } | null; segments: Cost[]; prefix: Cost }

function analyzeGroup(t: Txn): GroupTxn {
  const rs = t.records;
  const lockAt = rs.findIndex(is(SIG.counterRowLock));
  const hold = lockAt < 0 ? null : { ...cost(rs.slice(lockAt)), ms: round1(t.end - rs[lockAt]!.t) };
  const bounds: number[] = [];
  rs.forEach((r, i) => {
    if (!isStatement(r) || !SIG.attribution.test(flatSql(r.sql))) return;
    bounds.push(i > 0 && rs[i - 1]!.kind === 'describe' && rs[i - 1]!.sql === r.sql ? i - 1 : i);
  });
  const stop = lockAt < 0 ? rs.length : lockAt;
  const segments = bounds.map((b, i) => cost(rs.slice(b, i + 1 < bounds.length ? bounds[i + 1] : stop)));
  return { process: family(t.label), members: t.members, ...cost(rs), wall_ms: round1(t.end - t.start), committed: t.committed, hold, segments, prefix: cost(rs.slice(0, bounds[0] ?? 0)) };
}

/** Group publication breakdown (all processes): fixed vs per-member cost, steady member chain, completion and counter hold. */
export function publicationBreakdown(records: TraceRecord[]): Record<string, unknown> {
  const pubs = [...groupBy(records, r => r.pid).values()].flatMap(rs => transactions(rs).txns.filter(t => t.type === 'publication'));
  const groups = pubs.filter(t => t.members > 0).map(analyzeGroup);
  const ok = groups.filter(g => g.committed);
  const singles = pubs.filter(t => t.members === 0 && t.committed).map(t => ({ ...cost(t.records), wall: t.end - t.start }));
  const xs = ok.map(g => g.members);
  const steady = ok.filter(g => g.members >= 3).flatMap(g => g.segments.slice(1, -1));
  const first = ok.filter(g => g.members >= 2).map(g => g.segments[0]!);
  const held = ok.filter(g => g.hold);
  const holdFit = { statements: ols(held.map(g => g.members), held.map(g => g.hold!.statements)), waves: ols(held.map(g => g.members), held.map(g => g.hold!.waves)),
    ms: ols(held.map(g => g.members), held.map(g => g.hold!.ms)) };
  const chain = { statements_mean: mean(steady.map(s => s.statements)), waves_mean: mean(steady.map(s => s.waves)), describes_mean: mean(steady.map(s => s.describes)), segments: steady.length };
  const byMembers = [...groupBy(ok, g => g.members).entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([members, gs]) => ({
    members: Number(members), transactions: gs.length, statements_p50: pct(gs.map(g => g.statements), 50), waves_p50: pct(gs.map(g => g.waves), 50),
    describes_p50: pct(gs.map(g => g.describes), 50), wall_ms_p50: pct(gs.map(g => g.wall_ms), 50),
    hold_statements_p50: pct(gs.flatMap(g => g.hold ? [g.hold.statements] : []), 50), hold_waves_p50: pct(gs.flatMap(g => g.hold ? [g.hold.waves] : []), 50),
    hold_ms_p50: pct(gs.flatMap(g => g.hold ? [g.hold.ms] : []), 50) }));
  return {
    group_transactions: groups.length, committed: ok.length, rolled_back: groups.length - ok.length, members_total: sum(xs), members_p50: pct(xs, 50),
    fit: { waves: ols(xs, ok.map(g => g.waves)), statements: ols(xs, ok.map(g => g.statements)) },
    prefix: { statements_mean: mean(ok.map(g => g.prefix.statements)), waves_mean: mean(ok.map(g => g.prefix.waves)) },
    first_member_chain: { statements_mean: mean(first.map(s => s.statements)), waves_mean: mean(first.map(s => s.waves)), describes_mean: mean(first.map(s => s.describes)) },
    steady_member_chain: chain,
    completion_per_member: { statements: holdFit.statements?.per_member ?? null, waves: holdFit.waves?.per_member ?? null },
    per_page_publication_round_trips: chain.waves_mean !== null && holdFit.waves ? round1(chain.waves_mean + holdFit.waves.per_member) : null,
    per_page_publication_statements: chain.statements_mean !== null && holdFit.statements ? round1(chain.statements_mean + holdFit.statements.per_member) : null,
    counter_hold: {
      statements_p50: pct(held.map(g => g.hold!.statements), 50), statements_max: pct(held.map(g => g.hold!.statements), 100),
      waves_p50: pct(held.map(g => g.hold!.waves), 50), waves_max: pct(held.map(g => g.hold!.waves), 100),
      ms_p50: pct(held.map(g => g.hold!.ms), 50), ms_max: pct(held.map(g => g.hold!.ms), 100), fit: holdFit },
    by_members: byMembers,
    single_publications: { committed: singles.length, statements_p50: pct(singles.map(s => s.statements), 50), waves_p50: pct(singles.map(s => s.waves), 50), wall_ms_p50: pct(singles.map(s => s.wall), 50) },
    transactions: ok.slice(0, 200).map(({ segments: _s, prefix: _p, ...g }) => g),
    rules: { member_chain: RULES.member_chain, counter_hold: RULES.counter_hold },
  };
}

/**
 * Per put_page: the foreground process's admission, claim and single
 * publication transactions inside the write's window, and every record it sent
 * in that window (including its consumer's background work). `published_here`
 * keeps the writes its own consumer published; the others were published by
 * another process (the sync process's consumer) while it waited.
 */
export function foregroundRoundTrips(records: TraceRecord[], writes: Array<{ t: number; ms: number }>): Record<string, unknown> {
  const fg = records.filter(r => family(r.label) === 'foreground').sort(byStart);
  const txns = [...groupBy(fg, r => r.pid).values()].flatMap(rs => transactions(rs).txns)
    .filter(t => t.type === 'admission' || t.type === 'claim' || (t.type === 'publication' && t.members === 0));
  const per = writes.map(w => {
    const from = w.t - w.ms;
    const own = txns.filter(t => t.start >= from && t.start < w.t);
    return { write: cost(own.flatMap(t => t.records)), txns: own.length, here: own.some(t => t.type === 'publication'), window: cost(inWindow(fg, from, w.t)) };
  });
  const p = (xs: number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95) });
  const stats = (xs: typeof per) => ({ writes: xs.length, write_txns_p50: pct(xs.map(x => x.txns), 50),
    write_txn_statements: p(xs.map(x => x.write.statements)), write_txn_waves: p(xs.map(x => x.write.waves)),
    window_statements: p(xs.map(x => x.window.statements)), window_waves: p(xs.map(x => x.window.waves)) });
  return { ...stats(per), published_here: stats(per.filter(x => x.here)) };
}

const cell = (v: unknown) => v === null || v === undefined ? '—' : String(v);
function table(head: string[], rows: unknown[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Markdown tables for the log and `--analyze`. */
export function renderAnalysis(cp: Record<string, unknown>, pub: Record<string, unknown>): string {
  const phases = cp.phases as PhaseRow[];
  const check = cp.wave_check as Record<string, number | null>;
  const out = [`Critical path (sync process, ${cell(cp.pages)} pages; * = concurrent with other phases)`,
    table(['phase', 'n', 'wall ms', 'wall p50', 'stmts', 'stmts p50', 'waves', 'waves p50', 'describes', 'stmts/page', 'waves/page'],
      phases.map(p => [p.phase + (p.concurrent ? '*' : ''), p.occurrences, p.wall_ms_total, p.wall_ms_p50, p.statements, p.statements_p50, p.waves, p.waves_p50, p.describes, p.statements_per_page, p.waves_per_page])),
    `Wave check: ${cell(check.sync_waves)} waves for ${cell(check.sync_statements)} statements, ${cell(check.ms_per_wave)} ms per wave; publication wall ${cell(check.publication_wall_ms_per_wave)} ms per wave.`];
  const fit = pub.fit as { waves: Fit | null; statements: Fit | null };
  const chain = pub.steady_member_chain as Record<string, number | null>;
  const first = pub.first_member_chain as Record<string, number | null>;
  const hold = pub.counter_hold as Record<string, unknown> & { fit: Record<string, Fit | null> };
  const completion = pub.completion_per_member as Record<string, number | null>;
  const f = (x: Fit | null) => x ? `${x.fixed} + ${x.per_member}/member (r2 ${cell(x.r2)}, n ${x.n})` : '—';
  out.push(`\nGroup publication (${cell(pub.committed)} committed, ${cell(pub.rolled_back)} rolled back, ${cell(pub.members_total)} members)`,
    table(['members', 'txns', 'stmts p50', 'waves p50', 'describes p50', 'wall ms p50', 'hold stmts p50', 'hold waves p50', 'hold ms p50'],
      (pub.by_members as Array<Record<string, number | null>>).map(m => [m.members, m.transactions, m.statements_p50, m.waves_p50, m.describes_p50, m.wall_ms_p50, m.hold_statements_p50, m.hold_waves_p50, m.hold_ms_p50])),
    table(['measure', 'value'], [
      ['waves per transaction', f(fit.waves)], ['statements per transaction', f(fit.statements)],
      ['steady member chain (stmts / waves / describes)', `${cell(chain.statements_mean)} / ${cell(chain.waves_mean)} / ${cell(chain.describes_mean)} over ${cell(chain.segments)} segments`],
      ['first member chain (stmts / waves / describes)', `${cell(first.statements_mean)} / ${cell(first.waves_mean)} / ${cell(first.describes_mean)}`],
      ['completion per member (stmts / waves)', `${cell(completion.statements)} / ${cell(completion.waves)}`],
      ['per-page publication (stmts / waves)', `${cell(pub.per_page_publication_statements)} / ${cell(pub.per_page_publication_round_trips)}`],
      ['counter hold stmts p50 / max', `${cell(hold.statements_p50)} / ${cell(hold.statements_max)}; ${f(hold.fit.statements)}`],
      ['counter hold waves p50 / max', `${cell(hold.waves_p50)} / ${cell(hold.waves_max)}; ${f(hold.fit.waves)}`],
      ['counter hold ms p50 / max', `${cell(hold.ms_p50)} / ${cell(hold.ms_max)}; ${f(hold.fit.ms)}`],
    ]));
  return out.join('\n');
}
