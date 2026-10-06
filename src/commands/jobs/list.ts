/** `gbrain jobs list` (dispatched by runJobs in src/commands/jobs.ts). */
import { formatJob, hasFlag, parseFlag, rehydrateJobDates, type JobsCommandContext } from './shared.ts';
import type { MinionJob, MinionJobStatus } from '../../core/minions/types.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../../core/mcp-client.ts';

export async function runJobsList({ args, queue, engine }: JobsCommandContext): Promise<void> {
  const groupId = parseFlag(args, '--group');
  if (groupId !== undefined) return listSpendGroup(engine, groupId, hasFlag(args, '--json'));
  const status = parseFlag(args, '--status') as MinionJobStatus | undefined;
  const queueName = parseFlag(args, '--queue');
  const limit = parseInt(parseFlag(args, '--limit') ?? '20', 10);

  // v0.32: thin-client routing. The `list_jobs` MCP op is admin-scoped
  // but not localOnly, so a thin-client install with admin access can
  // see the remote brain's job queue. Without this branch we'd query
  // the empty local PGLite and report "No jobs found" for an actively-
  // running host brain.
  const cfg = loadConfig();
  let jobs: MinionJob[];
  if (isThinClient(cfg)) {
    const raw = await callRemoteTool(cfg!, 'list_jobs', {
      status, queue: queueName, limit,
    }, { timeoutMs: 30_000 });
    jobs = unpackToolResult<MinionJob[]>(raw).map((j) => rehydrateJobDates(j));
  } else {
    try { await queue.ensureSchema(); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
    jobs = await queue.getJobs({ status, queue: queueName, limit });
  }

  // #3685: --json emits the machine-readable array the CHANGELOG's
  // scripting guidance promises (before this guard the flag was accepted
  // and silently discarded — scripts got the padded ASCII table). Guard
  // sits BEFORE the empty-check so an empty queue emits `[]`, not prose.
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  console.log(`  ${'ID'.padEnd(6)} ${'Name'.padEnd(14)} ${'Status'.padEnd(20)} ${'Queue'.padEnd(10)} ${'Time'.padEnd(8)} Created`);
  console.log('  ' + '─'.repeat(80));
  for (const job of jobs) console.log(formatJob(job));
  console.log(`\n  ${jobs.length} jobs shown`);
}

/** `jobs list --group <id>`: one spend group's record, amounts and member jobs. */
async function listSpendGroup(engine: JobsCommandContext['engine'], groupId: string, json: boolean): Promise<void> {
  const { groupJobs, jobGroupAmounts } = await import('../../core/minions/spend-authorization.ts');
  const jobs = await groupJobs(engine, groupId);
  const record = jobs[0]?.spend_authorization ?? null;
  const amounts = record ? await jobGroupAmounts(engine, record) : null;
  const doc = {
    group_id: groupId,
    ...(record ? { command: record.command, kind: record.kind, cap_usd: record.cap_usd, cap_source: record.cap_source, uncapped: record.uncapped === true } : {}),
    ...(amounts ? { spent_usd: amounts.spent_usd, reserved_usd: amounts.reserved_usd, overdue_usd: amounts.overdue_usd, remaining_usd: amounts.remaining_usd } : {}),
    jobs: jobs.map(j => ({ id: j.id, name: j.name, status: j.status, error_text: j.error_text })),
    cancel_argv: ['gbrain', 'jobs', 'cancel', '--group', groupId],
  };
  if (json) { console.log(JSON.stringify(doc, null, 2)); return; }
  if (!jobs.length) { console.log(`No jobs in spend group ${groupId}.`); return; }
  console.log(`Spend group ${groupId}: ${record!.command}, ${record!.uncapped ? 'uncapped' : `$${record!.cap_usd!.toFixed(2)} ${record!.cap_source} cap`}`
    + (amounts ? `; spent $${amounts.spent_usd.toFixed(2)}, reserved $${amounts.reserved_usd.toFixed(2)}${amounts.remaining_usd === null ? '' : `, remaining $${amounts.remaining_usd.toFixed(2)}`}` : ''));
  for (const job of jobs) console.log(formatJob(job));
  console.log(`\n  ${jobs.length} jobs. Cancel the unfinished ones with: gbrain jobs cancel --group ${groupId}`);
}
