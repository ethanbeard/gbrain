/**
 * F6: the hidden-tool hint on the owner's stdio pipe. A stdio caller that
 * names a real tool outside this server's surface (or its read-only access)
 * learns that the tool exists and how to reach it. Where `request_tools` is
 * callable and session widening is on, the fix is one `request_tools
 * {surface: 'full'}` call (no restart, nothing persists); otherwise it is the
 * tool's CLI equivalent, relayed to the user. The stdio pipe is the brain
 * owner's own process, so this is not an existence oracle; HTTP keeps the
 * opaque unknown_tool envelope.
 */
import type { Action } from '../core/agent-output.ts';
import type { Operation } from '../core/operations.ts';
import { cliEquivalent } from '../core/ops/cli-equivalent.ts';

const PERSISTENT_ROUTE = 'To keep the full surface for new sessions, set GBRAIN_SURFACE=full in the env of this harness\'s MCP server entry for gbrain '
  + '(`claude mcp add gbrain -e GBRAIN_SURFACE=full -- …`, the env table of the Codex server entry, or the plugin\'s GBRAIN_SURFACE setting on launcher installs), '
  + 'or re-register the server with `--surface full`. An inherited GBRAIN_SURFACE overrides a pinned --surface.';

export function hiddenToolHint(
  op: Operation | undefined,
  opts: { transport?: string; remote?: boolean; surface?: string; allowedOps?: ReadonlySet<string> },
  canWiden = false,
): { suggestion: string; fix: Action } | null {
  if (!op || op.localOnly || opts.transport !== 'stdio' || opts.remote === false || !opts.allowedOps || opts.allowedOps.has(op.name)) return null;
  const name = op.name;
  const argv = cliEquivalent(op);
  const surface = opts.surface ?? 'full';
  const inputs = argv.includes('<params_json>') ? { inputs: [{ name: 'params_json', how: `The arguments you passed to ${name}, as one JSON object.` }] } : {};
  if (surface === 'full') {
    const why = `${name} exists, but this server is read-only (access read-only), so it is not listed. Its CLI equivalent does the same on the brain host; this connection stays read-only.`;
    return { suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`, fix: { argv, consent: [], actor: 'agent', requires_exclusive: false, why, ...inputs } };
  }
  if (canWiden) {
    const why = `${name} exists, but this session serves the ${surface} tool surface, which does not include it. `
      + `Call request_tools {"surface":"full"} to add it to this session (no restart; nothing is written), then call ${name} by name. ${PERSISTENT_ROUTE}`;
    return {
      suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`,
      fix: { mcp: { tool: 'request_tools', arguments: { surface: 'full' } }, argv, consent: [], actor: 'agent', requires_exclusive: false, why, ...inputs },
    };
  }
  const why = `${name} exists, but this server runs the ${surface} tool surface, which does not include it, and this session cannot widen it. `
    + `Its CLI equivalent does the same on the brain host. ${PERSISTENT_ROUTE}`;
  return {
    suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`,
    fix: {
      argv, consent: [], actor: 'user', requires_exclusive: false, why,
      user_message: `The ${name} tool is not in this session's gbrain tool set. You can run \`${argv.join(' ')}\` on the brain host, or add GBRAIN_SURFACE=full to the gbrain MCP server's env in your agent app and start a new session.`,
      ...inputs,
    },
  };
}
