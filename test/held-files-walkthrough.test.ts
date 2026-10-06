/**
 * Doc test for docs/guides/repair.md "Held files" (#5988). It builds the
 * walkthrough's fixture with the real CLI on a throwaway PGLite brain: a Git
 * source synced once, then three generator-written notes committed while
 * `sync.holds=fail` (the pre-upgrade fail-closed behavior) so the source is
 * blocked. Then it runs every `$ ` command in the section's console blocks, in
 * order, and checks that each output line the guide shows appears in the
 * real output (ids, hashes, times and the checkout path normalized), and that
 * every command exits 0. A changed message, command or flow fails here before
 * the guide can drift from the CLI.
 *
 * Protects: the documented recovery path (post-upgrade notice, in-place
 * conversion, sources status, two-pass hash-bound repair with --skip/--only,
 * clean sync, doctor). Serial: it spawns about twenty CLI processes.
 */
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'gbrain-held-walkthrough-'));
const checkout = join(work, 'notes');
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && !['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID'].includes(key))) as Record<string, string>;
env.GBRAIN_HOME = join(work, 'home');

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(argv: string[]): { out: string; status: number | null } {
  const [cmd, ...args] = argv[0] === 'gbrain' ? [process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), ...argv.slice(1)] : argv;
  const result = spawnSync(cmd!, args, { cwd: REPO, env, encoding: 'utf8', timeout: 120_000 });
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status };
}

function ok(argv: string[]): string {
  const result = run(argv);
  if (result.status !== 0) throw new Error(`${argv.join(' ')} exited ${result.status}:\n${result.out}`);
  return result.out;
}

const write = (files: Record<string, string>) => { for (const [path, content] of Object.entries(files)) writeFileSync(join(checkout, path), content); };
const commit = (message: string) => { ok(['git', '-C', checkout, 'add', '-A']); ok(['git', '-C', checkout, 'commit', '-qm', message]); };

/** The guide's placeholders for values that differ per run. */
function normalize(text: string): string {
  return text.split(checkout).join('~/brain/notes')
    .replace(/\b[0-9a-f]{64}\b/g, '<hash>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?Z?)?/g, '<time>');
}

/** `a "b c" d` -> [a, b c, d]; `\"` stays a literal quote outside the guide's simple commands. */
function tokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]!);
}

interface Step { command: string; expected: string[] }

function walkthrough(): Step[] {
  const guide = readFileSync(join(REPO, 'docs', 'guides', 'repair.md'), 'utf8');
  const section = guide.slice(guide.indexOf('<a id="held-files"></a>'), guide.indexOf('<a id="frontmatter"></a>'));
  const steps: Step[] = [];
  for (const block of section.matchAll(/```console\n([\s\S]*?)```/g)) {
    for (const raw of block[1]!.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('$ ')) steps.push({ command: line.slice(2), expected: [] });
      else steps.at(-1)!.expected.push(line);
    }
  }
  return steps;
}

test('docs/guides/repair.md "Held files": every command runs and prints every line the guide shows', () => {
  const steps = walkthrough();
  expect(steps.map(step => step.command.split(' ').slice(0, 3).join(' '))).toContain('gbrain repair frontmatter');
  expect(steps.length).toBeGreaterThanOrEqual(12);

  // A source synced once by the older gbrain.
  mkdirSync(join(checkout, 'notes'), { recursive: true });
  ok(['git', 'init', '-q', checkout]);
  ok(['git', '-C', checkout, 'config', 'user.name', 'Example']);
  ok(['git', '-C', checkout, 'config', 'user.email', 'example@example.invalid']);
  write({ 'notes/roadmap.md': '---\ntitle: Widget roadmap\n---\nThe quarterly widget roadmap.\n', 'notes/standup.md': '---\ntitle: Standup\n---\nDaily standup notes.\n' });
  commit('init');
  ok(['gbrain', 'init', '--pglite', '--no-embedding']);
  ok(['gbrain', 'config', 'set', 'self_upgrade.mode', 'off']);
  ok(['gbrain', 'sources', 'add', 'notes', '--path', checkout]);
  ok(['gbrain', 'sync', '--source', 'notes', '--no-pull']);

  // The generator's notes block the source under the pre-upgrade behavior.
  ok(['gbrain', 'config', 'set', 'sync.holds', 'fail']);
  write({
    'notes/standup.md': '---\ntitle: Standup with acme-example\nthe team agreed to ship on Friday\n---\nDaily standup notes.\n',
    'notes/digest.md': '---\ntitle: Weekly digest\ntags: [launch, widgets]\ntitle: Weekly digest (draft)\n---\nWhat shipped this week.\n',
    'notes/roundup.md': '---\ntitle: Payments roundup\nauthor: acme-example (citing fund-a) (original: https://example.com/post/1)\n---\nA roundup of payments news.\n',
  });
  commit('notes from the generator');
  const blocked = run(['gbrain', 'sync', '--source', 'notes', '--no-pull']);
  expect(blocked.status).not.toBe(0);
  expect(blocked.out).toContain('Sync BLOCKED');
  ok(['gbrain', 'config', 'unset', 'sync.holds']);

  let lastHash: string | undefined;
  for (const step of steps) {
    const argv = tokens(step.command).map(token => token === '<hash>' ? lastHash ?? '<no preview hash yet>' : token.replace('~/brain/notes', checkout));
    const out = ok(argv);
    lastHash = [...out.matchAll(/--expect ([0-9a-f]{64})/g)].at(-1)?.[1] ?? lastHash;
    const shown = normalize(out);
    for (const line of step.expected) {
      if (!shown.includes(line)) throw new Error(`"$ ${step.command}" no longer prints the guide's line:\n  ${line}\nActual output:\n${shown}`);
    }
  }
  expect(run(['git', '-C', checkout, 'status', '--porcelain']).out).toBe('');
}, 600_000);
