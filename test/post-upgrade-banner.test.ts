/**
 * `gbrain post-upgrade` recovery banner (fix wave 3, Lane D): one [AGENT]
 * block on a brain with wave findings, naming the brain, each finding's count
 * and the read-only preview; nothing on a clean brain; never an applying
 * command. The banner runs the full wave checks, not doctor --fast.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { put, waveBrain } from './helpers/wave-fixture.ts';

/** A CLAUDE_CONFIG_DIR holding one gbrain claude-cli scratch-project transcript (session `sess-self`). */
function selfCaptureHost(): string {
  const claude = mkdtempSync(join(tmpdir(), 'gbrain-banner-claude-'));
  const scratch = join(claude, 'projects', '-tmp-gbrain-claude-cli-cwd-4242');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'sess-self.jsonl'), '{}\n');
  return claude;
}

describe('post-upgrade recovery banner', () => {
  test('a brain with wave findings gets one preview-only [AGENT] banner', async () => {
    await waveBrain(async ({ engine }) => {
      const lines = await postUpgradeRecoveryBanner(engine, 'host (pglite, id test-brain)');
      const text = lines.join('\n');
      expect(lines.filter(l => l.includes('Relay this to your operator'))).toHaveLength(1);
      expect(text).toContain('brain host (pglite, id test-brain)');
      expect(text).toContain('timeline_history: 1 (repairable after the user agrees)');
      expect(text).toContain('self_capture: 1 (needs an operator action)');
      expect(text).toContain('stale_embedding_effects: 1 (repairable after the user agrees)');
      expect(text).toContain('Preview (read-only): gbrain doctor --remediation-plan');
      expect(text).toContain('Ask the user before applying');
      expect(text).not.toContain('--yes');
      expect(text).not.toContain('--apply');
      for (const line of lines.filter(Boolean)) expect(line).toStartWith('[AGENT]');
    });
  }, 180_000);

  test('a clean brain prints nothing', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'notes/clean', 'Nothing to repair.');
      expect(await postUpgradeRecoveryBanner(engine, 'host')).toEqual([]);
    });
  }, 180_000);

  test('captured facts from gbrain\'s own sessions name the captured-facts preview (D14)', async () => {
    const claude = selfCaptureHost();
    try {
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, () => managedBrain(async ({ engine }) => {
        for (const fact of ['Alice Example prefers Rust for systems work', 'Alice Example ships on Fridays']) {
          await writeSingleFact(engine, 'default', { fact, entity: 'people/alice-example', provenance: 'hook:writeback', sessionId: 'sess-self' });
        }
        const text = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
        expect(text).toContain('[AGENT]   captured_facts_active: 2 (explicit_kind_required; preview with: gbrain repair captured-facts)');
        expect(text).not.toContain('loop_facts_drift');
        expect(text).not.toContain('--apply');
      }));
    } finally { rmSync(claude, { recursive: true, force: true }); }
  }, 180_000);

  test('closed loops with an active commitment fact name the loop-facts preview (D14)', async () => {
    await managedBrain(async ({ engine }) => {
      const { id: factId } = await writeSingleFact(engine, 'default', { fact: 'Send the deck by Friday', entity: 'people/alice-example', provenance: 'cli:remember' });
      const { id: loopId } = await upsertOpenLoop(engine, { sourceId: 'default', dedupKey: 'commit:deck', loopType: 'commitment_owed_by_me',
        summary: 'Send the deck by Friday', evidence: [], threadId: 'example', pageSlug: 'emails/example', detector: 'llm_extract', factId });
      // What loops_close left before #5869: the loop closed, its fact still active.
      await engine.executeRaw("UPDATE open_loops SET status='done', closed_at=now(), closed_by='manual' WHERE id=$1", [loopId]);
      const text = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
      expect(text).toContain('[AGENT]   loop_facts_drift: 1 (explicit_kind_required; preview with: gbrain repair loop-facts)');
      expect(text).not.toContain('captured_facts_active');
      expect(text).not.toContain('--apply');
    });
  }, 180_000);

});

describe('gbrain post-upgrade', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-banner-cli-'));
  const claude = selfCaptureHost();
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
      cwd: home, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: claude, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_SKIP_REFERENCE_SWEEP: '1' },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };

  beforeAll(async () => {
    const init = await cli('init', '--pglite', '--no-embedding');
    expect(init.code, init.stderr).toBe(0);
    const { database_path } = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    await withEnv({ GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: claude }, async () => {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path });
      try {
        for (const fact of ['Alice Example prefers Rust for systems work', 'Alice Example ships on Fridays']) {
          await writeSingleFact(engine, 'default', { fact, entity: 'people/alice-example', provenance: 'hook:writeback', sessionId: 'sess-self' });
        }
      } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    });
  }, 180_000);
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  });

  test('relays the recovery banner for a brain with findings and never an applying advisory', async () => {
    const upgraded = await cli('post-upgrade', '--no-autopilot-install');
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain('[AGENT] Relay this to your operator');
    expect(upgraded.stdout).toContain('[AGENT]   captured_facts_active: 2 (explicit_kind_required; preview with: gbrain repair captured-facts)');
    expect(`${upgraded.stdout}${upgraded.stderr}`).not.toMatch(/safe[- ]chunk/i);
    expect(upgraded.stdout).not.toContain('--apply');
  }, 180_000);
});
