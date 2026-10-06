/**
 * scripts/check-test-env-opt-ins.ts (D7): a test gating execution on a
 * GBRAIN_* opt-in the operator-env preload strips is a silent skip. The
 * guard-self-test harness proves the bad fixtures fail and the good one
 * passes; this file pins the agent-facing output (Why / Fix / Docs, with an
 * anchor that exists) and that the real tree is clean.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-test-env-opt-ins.ts');
const FIXTURES = join(REPO, 'test', 'fixtures', 'guards', 'check-test-env-opt-ins.ts');

function run(root?: string) {
  return spawnSync('bun', [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, ...(root ? { GBRAIN_GUARD_ROOT: root } : {}) },
  });
}

describe('check-test-env-opt-ins', () => {
  test('names each dead gate with file:line and prints Why / Fix / Docs', () => {
    const r = run(join(FIXTURES, 'bad-derived'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL [test_env_opt_in_stripped]: test/opt-in-const.ts:4 gates execution on GBRAIN_FIXTURE_SKIP_SUBPROCESS');
    expect(r.stderr).toMatch(/^Why: .*operator-env-preload\.ts strips every GBRAIN_\* name/m);
    expect(r.stderr).toMatch(/^Fix: rename the opt-in to GBRAIN_TEST_<AREA>_<WHAT>.*RENAMED in test\/helpers\/operator-env-policy\.ts/m);
    const anchor = r.stderr.match(/^Docs: docs\/TESTING\.md#([a-z0-9-]+)$/m)?.[1];
    expect(anchor).toBeDefined();
    const headings = readFileSync(join(REPO, 'docs', 'TESTING.md'), 'utf8')
      .split('\n')
      .filter(l => l.startsWith('#'))
      .map(l => l.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
    expect(headings).toContain(anchor!);
  });

  test('the real tree is clean', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
