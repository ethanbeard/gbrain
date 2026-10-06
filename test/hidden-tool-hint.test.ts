/**
 * F6 hidden-tool hint (src/mcp/hidden-tool-hint.ts): on the owner's stdio
 * pipe a real tool outside the session's surface names itself; the fix is
 * one `request_tools {surface:'full'}` call (`next: run`) where request_tools
 * is callable and session widening is on, else the CLI equivalent relayed to
 * the user with the persistent routes (`tell_user_to_run`). Read-only access
 * never offers a widen; HTTP stays opaque.
 */
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { allowedOpNames, isReadOnlyOperation } from '../src/mcp/surface.ts';
import { hiddenToolHint } from '../src/mcp/hidden-tool-hint.ts';
import { dispatchRenderContext } from '../src/mcp/dispatch.ts';
import { renderAction } from '../src/core/agent-output.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const starter = allowedOpNames(operations, 'starter');
const verbs = allowedOpNames(operations, 'verbs');
const readOnly = new Set(operations.filter(o => starter.has(o.name) && isReadOnlyOperation(o)).map(o => o.name));
const stdio = (allowedOps: ReadonlySet<string>, surface: 'verbs' | 'starter') => ({ transport: 'stdio' as const, remote: true, surface, allowedOps });
const rendered = (opts: ReturnType<typeof stdio>, canWiden: boolean) => {
  const hint = hiddenToolHint(op('get_health'), opts, canWiden)!;
  return { hint, fix: renderAction(hint.fix, dispatchRenderContext({ ...opts, sourceId: 'default' })) };
};

describe('hidden-tool hint', () => {
  test('a widenable starter session: the fix is the request_tools call, next run, CLI equivalent kept as argv', () => {
    const { hint, fix } = rendered(stdio(starter, 'starter'), true);
    expect(fix.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
    expect(fix.next).toBe('run');
    expect(fix.consent).toEqual([]);
    expect(fix.argv?.slice(0, 3)).toEqual(['gbrain', 'doctor', '--json']);
    expect(hint.fix.why).toContain('GBRAIN_SURFACE=full');
    expect(hint.fix.why).toContain('An inherited GBRAIN_SURFACE overrides a pinned --surface');
    expect(hint.fix.why).toContain('claude mcp add gbrain -e GBRAIN_SURFACE=full');
  });

  test('verbs (request_tools absent) or widening off: the persistent route, relayed to the user', () => {
    for (const [opts, canWiden] of [[stdio(verbs, 'verbs'), false], [stdio(starter, 'starter'), false]] as const) {
      const { hint, fix } = rendered(opts, canWiden);
      expect(fix.mcp).toBeUndefined();
      expect(fix.next).toBe('tell_user_to_run');
      expect(fix.user_message).toContain('GBRAIN_SURFACE=full');
      expect(hint.suggestion).toContain('cannot widen it');
    }
  });

  test('read-only access names the CLI equivalent and never offers a widen', () => {
    const opts = { transport: 'stdio' as const, remote: true, surface: 'full' as const, allowedOps: readOnly };
    const hint = hiddenToolHint(op('put_page'), opts, true)!;
    expect(hint.fix.mcp).toBeUndefined();
    expect(hint.fix.why).toContain('this connection stays read-only');
  });

  test('HTTP, the local CLI and visible tools get no hint', () => {
    expect(hiddenToolHint(op('get_health'), { transport: 'http', remote: true, surface: 'starter', allowedOps: starter }, true)).toBeNull();
    expect(hiddenToolHint(op('get_health'), { transport: 'stdio', remote: false, surface: 'starter', allowedOps: starter }, true)).toBeNull();
    expect(hiddenToolHint(op('search'), stdio(starter, 'starter'), true)).toBeNull();
  });
});
