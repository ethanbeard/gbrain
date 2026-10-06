/**
 * Throw-only host connect (src/core/engine-connect.ts), the connect the
 * status-only serve re-probes through.
 *
 * Protects: a config that vanished between a re-probe and the connect throws
 * the classified `no_brain` error (the CLI wrapper exits; a status daemon must
 * not), and an engine whose startup fails after the connect is disconnected,
 * so the PGLite lock is free for the next attempt.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectEngineForServe, type EngineConnectHooks } from '../src/core/engine-connect.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const hooks = (completeStartup: (e: BrainEngine) => Promise<void> = async () => {}): EngineConnectHooks => ({
  SELECTED_CONFIG_BY_ENGINE: new WeakMap<BrainEngine, GBrainConfig>(), completeStartup,
});

describe('connectEngineForServe', () => {
  test('no config throws no_brain with the keyless-init fix instead of exiting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-engine-connect-none-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const err = await connectEngineForServe(hooks()).then(() => null, (e: unknown) => e as { code?: string; fix?: { argv?: string[] } });
        expect(err?.code).toBe('no_brain');
        expect(err?.fix?.argv).toEqual(['gbrain', 'init', '--pglite', '--no-embedding']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a startup failure after the connect disconnects the engine, so the next connect opens the brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-engine-connect-partial-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        let failed: BrainEngine | null = null;
        const err = await connectEngineForServe(hooks(async e => { failed = e; throw new Error('startup failed'); })).then(() => null, (e: Error) => e);
        expect(err?.message).toBe('startup failed');
        expect(failed).not.toBeNull();
        const engine = await connectEngineForServe(hooks());
        try {
          expect(engine.kind).toBe('pglite');
        } finally {
          await engine.disconnect();
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
