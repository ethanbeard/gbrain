import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'change'); };
const setup = ({ root }: { root: string }) => { git(root, 'init', '-q'); writeFileSync(join(root, 'note.md'), 'Original note.\n'); commit(root); };

async function capture(engine: BrainEngine, args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const out = process.stdout.write, err = process.stderr.write, log = console.log, error = console.error;
  process.stdout.write = ((value: unknown) => { stdout.push(String(value)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((value: unknown) => { stderr.push(String(value)); return true; }) as typeof process.stderr.write;
  console.log = (...values: unknown[]) => { stdout.push(values.join(' ') + '\n'); };
  console.error = (...values: unknown[]) => { stderr.push(values.join(' ') + '\n'); };
  _resetCliExitVerdictForTests(); process.exitCode = 0;
  try { await runSync(engine, args); } finally { process.stdout.write = out; process.stderr.write = err; console.log = log; console.error = error; }
  return { stdout: stdout.join(''), stderr: stderr.join(''), exit: currentExitCode() };
}

test('CLI reports a deferral, exits zero, and passes it through JSON', () => managedBrain(async ({ engine, root }) => {
  await capture(engine, ['--source', 'default', '--no-pull', '--no-embed', '--no-extract', '--no-bulk']);
  writeFileSync(join(root, 'note.md'), 'Committed note.\n'); commit(root);
  writeFileSync(join(root, 'note.md'), 'Divergent note.\n');
  const human = await capture(engine, ['--source', 'default', '--no-pull', '--no-embed', '--no-extract', '--no-bulk']);
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain('Deferred 1 page(s)');
  expect(human.stdout).toContain('note');

  writeFileSync(join(root, 'note.md'), 'Second committed note.\n'); commit(root);
  writeFileSync(join(root, 'note.md'), 'Second divergent note.\n');
  const json = await capture(engine, ['--source', 'default', '--no-pull', '--no-embed', '--no-extract', '--no-bulk', '--json']);
  expect(json.exit).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ deferred: [{ path: 'note.md', reason: 'pinned_git_worktree_conflict' }] });
}, { setup }), 120_000);

test('CLI still exits one for a real managed-sync failure', () => managedBrain(async ({ engine, root }) => {
  await engine.setConfig('sync.holds', 'fail');
  writeFileSync(join(root, 'note.md'), '---\ntitle: [broken\n---\n'); commit(root);
  const result = await capture(engine, ['--source', 'default', '--no-pull', '--no-embed', '--no-extract', '--no-bulk']);
  expect(result.exit).toBe(1);
}, { setup }), 120_000);
