/**
 * One surface for every stdio registration gbrain writes
 * (src/core/mcp-registration.ts): readiness (Claude Code, Codex, opencode),
 * init's quickstart line, `registerClaudeMcp` / `registerCodexMcp`, and the
 * plugin generator all build from REGISTRATION_SURFACE through
 * `stdioServeArgv`; `registeredSurface` reads an existing entry's form for
 * never-narrow. The opencode user/project writer and the exec-lane
 * replacement are driven end to end in bootstrap-opencode-door.serial and
 * bootstrap-dispatcher.serial.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REGISTRATION_SURFACE, registeredSurface, stdioServeArgv } from '../src/core/mcp-registration.ts';
import { harnessWiringEntry } from '../src/core/readiness.ts';
import { registerClaudeMcp, registerCodexMcp } from '../src/core/bootstrap/hooks.ts';

const BIN = '/opt/example/bin/gbrain';
const ROOT = resolve(import.meta.dir, '..');
const wiring = (h: 'claude-code' | 'codex' | 'opencode', surface?: 'verbs' | 'starter' | 'full') =>
  harnessWiringEntry({ transport: 'cli', harnesses: [h], lockOwner: null, gbrainBin: BIN, ...(surface ? { surface } : {}) }).fix;

describe('REGISTRATION_SURFACE and stdioServeArgv', () => {
  test('new registrations pin starter; null renders a bare serve', () => {
    expect(REGISTRATION_SURFACE).toBe('starter');
    expect(stdioServeArgv(BIN)).toEqual([BIN, 'serve', '--surface', 'starter']);
    expect(stdioServeArgv(BIN, 'full')).toEqual([BIN, 'serve', '--surface', 'full']);
    expect(stdioServeArgv(BIN, null)).toEqual([BIN, 'serve']);
  });

  test('registeredSurface reads a pinned value, a bare serve, or nothing', () => {
    expect(registeredSurface(`gbrain:\n  Command: ${BIN}\n  Args: serve --surface full\n`)).toBe('full');
    expect(registeredSurface(`${BIN} serve --surface=verbs --source-guard`)).toBe('verbs');
    expect(registeredSurface(`gbrain:\n  Command: ${BIN}\n  Args: serve\n`)).toBeNull();
    expect(registeredSurface('gbrain: http https://brain.example/mcp')).toBeUndefined();
  });
});

describe('every stdio registration path builds from REGISTRATION_SURFACE', () => {
  test('readiness harness_wiring: Claude Code and Codex pin the surface; opencode runs bootstrap hooks', () => {
    expect(wiring('claude-code')?.argv).toEqual(['claude', 'mcp', 'add', 'gbrain', '--', ...stdioServeArgv(BIN)]);
    expect(wiring('codex')?.argv).toEqual(['codex', 'mcp', 'add', 'gbrain', '--', ...stdioServeArgv(BIN)]);
    expect(wiring('opencode')?.argv).toEqual(['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks']);
    expect(wiring('claude-code')?.why).toContain(`${BIN} serve --surface starter`);
  });

  test('init --surface reaches the readiness fix (the quickstart line and the first-run harness decision read it)', () => {
    expect(wiring('claude-code', 'full')?.argv).toEqual(['claude', 'mcp', 'add', 'gbrain', '--', BIN, 'serve', '--surface', 'full']);
    expect(wiring('opencode', 'verbs')?.argv).toEqual(['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks', '--surface', 'verbs']);
    const missing = harnessWiringEntry({ transport: 'cli', harnesses: [], lockOwner: null, gbrainBin: BIN }).fix;
    expect(missing?.why).toContain('serve --surface starter');
  });

  test('bootstrap hooks: registerClaudeMcp and registerCodexMcp default to the surface and carry an existing form', () => {
    const claude = registerClaudeMcp({ gbrainBin: BIN, scope: 'user', sourceId: 'workspace' })[0];
    const codex = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace' })[0];
    expect(claude.slice(claude.indexOf('--') + 1)).toEqual(stdioServeArgv(BIN));
    expect(codex.slice(codex.indexOf('--') + 1)).toEqual(stdioServeArgv(BIN));
    expect(registerClaudeMcp({ gbrainBin: BIN, scope: 'user', sourceId: 'w', surface: 'full' })[0].slice(-3)).toEqual(['serve', '--surface', 'full']);
    expect(registerCodexMcp({ gbrainBin: BIN, sourceId: 'w', surface: null })[0].slice(-2)).toEqual([BIN, 'serve']);
  });

  test('the plugin generator states the registration surface and refuses a manifest pinned elsewhere', () => {
    const out = mkdtempSync(join(tmpdir(), 'gb-reg-plugin-'));
    try {
      const ok = spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(out, 'plugin')], { encoding: 'utf8', timeout: 60_000 });
      expect(ok.status, ok.stderr).toBe(0);
      expect(readFileSync(join(out, 'plugin', 'README.md'), 'utf8')).toContain(`gbrain serve --surface ${REGISTRATION_SURFACE}`);
      for (const file of ['.codex-plugin/mcp.json', '.claude-plugin/plugin.json']) {
        const args = (JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { mcpServers: { gbrain: { args: string[] } } }).mcpServers.gbrain.args;
        expect(args[args.indexOf('--surface') + 1]).toBe(REGISTRATION_SURFACE);
      }

      const root = join(out, 'fixture');
      mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
      mkdirSync(join(root, 'skills', 'conventions'), { recursive: true });
      mkdirSync(join(root, '.codex-plugin'), { recursive: true });
      writeFileSync(join(root, 'VERSION'), '0.0.0.0\n');
      writeFileSync(join(root, 'openclaw.plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha'], shared_deps: [] }));
      writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: fixture skill\n---\n# alpha\n');
      writeFileSync(join(root, 'skills', 'manifest.json'), JSON.stringify({ skills: [{ name: 'alpha' }] }));
      writeFileSync(join(root, 'skills', 'plugin-lanes.json'), JSON.stringify({ starter_policy: 'x', additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {} }));
      writeFileSync(join(root, '.codex-plugin', 'mcp.json'), JSON.stringify({ mcpServers: { gbrain: { command: 'x', args: ['serve', '--surface', 'full'] } } }));
      const bad = spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(root, 'out')], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: root },
      });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(`.codex-plugin/mcp.json pins --surface full; plugin lanes serve the registration surface '${REGISTRATION_SURFACE}'`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
