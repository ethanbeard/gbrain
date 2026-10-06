/**
 * embeddings doctor check reports the embedding backlog (Foundations 1, F4d).
 *
 * Protects: when chunks lack embeddings, the `embeddings` check names the
 * backlog count and the command that finishes it (`gbrain embed --stale
 * --catch-up`), says it makes paid calls, and carries the same facts in
 * `details` for agents. A clean brain keeps the golden-pinned message.
 * Fails when: the check goes back to recommending a plain `embed --stale`,
 * which stops after its 30-minute budget and on a 52k-document brain left
 * 51,910 chunks behind without saying so.
 * Why new: no test exercised the embeddings check's messages; the doctor
 * goldens only pin the fully embedded case.
 * A keyless brain reports "not applicable" instead of a paid fix.
 * Seam: none (a stub engine answering getHealth and getConfig).
 */
import { describe, expect, test } from 'bun:test';
import { embeddingsEntry } from '../src/commands/doctor/checks/schema-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

async function runCheck(ctx: DoctorContext): Promise<Check[]> {
  return await embeddingsEntry.run(ctx) as Check[];
}

function ctxFor(coverage: number, missing: number, config: Record<string, string> = {}): DoctorContext {
  const engine = {
    getHealth: async () => ({ embed_coverage: coverage, missing_embeddings: missing }),
    getConfig: async (key: string) => config[key] ?? null,
  };
  return { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
}

describe('embeddings doctor check: backlog', () => {
  test('a large backlog warns with the count and the catch-up command', async () => {
    const [check] = await runCheck(ctxFor(0.002, 51_910));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Backlog: 51910 chunk(s) without embeddings');
    expect(check.message).toContain('Fix: gbrain embed --stale --catch-up');
    expect(check.message).toContain('paid embedding calls');
    expect(check.details).toMatchObject({ code: 'embedding_backlog', backlog: 51_910, fix: 'gbrain embed --stale --catch-up' });
  });

  test('a brain with no embeddings yet names the backlog too', async () => {
    const [check] = await runCheck(ctxFor(0, 1200));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Backlog: 1200 chunk(s)');
  });

  test('a mostly embedded brain stays ok but still reports its backlog', async () => {
    const [check] = await runCheck(ctxFor(0.95, 2600));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Backlog: 2600 chunk(s)');
    expect(check.details).toMatchObject({ backlog: 2600 });
  });

  test('a keyless brain is not applicable, never told to make paid calls', async () => {
    const [check] = await runCheck(ctxFor(0, 200, { embedding_disabled: 'true' }));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Not applicable: embeddings are disabled');
    expect(check.message).not.toContain('catch-up');
  });

  test('a fully embedded brain keeps its message and carries no backlog', async () => {
    const [check] = await runCheck(ctxFor(1, 0));
    expect(check).toEqual({ name: 'embeddings', status: 'ok', message: '100% coverage, 0 missing' });
  });
});
