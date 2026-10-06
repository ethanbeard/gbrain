#!/usr/bin/env bun
/**
 * Test env opt-in guard (docs/TESTING.md#test-isolation-lint-and-helpers).
 *
 * test/helpers/operator-env-preload.ts deletes every GBRAIN_* variable outside
 * its keep-lists before any test file loads. A test that gates execution on a
 * stripped name (`describe.skipIf(!process.env.GBRAIN_X)`, `if (env) return`,
 * a top-level constant used that way) can never see it set, so the gate is a
 * silent no-op: six opt-ins, including `bun run test:compile-smoke`, were dead
 * this way. This guard parses every test file under test/ and evals/ with the
 * TypeScript AST and fails on an execution-gating read of a GBRAIN_* name the
 * scrub strips, unless the same file assigns that name itself. Names that
 * src/ reads are product configuration, not test opt-ins: the scrub removing
 * them is the hermeticity it exists for, so a test asserting their absence is
 * not flagged.
 *
 * The policy (keep-lists, RENAMED map, naming rule) is imported from
 * test/helpers/operator-env-policy.ts, the module the preload applies.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isStripped } from '../test/helpers/operator-env-policy';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#test-isolation-lint-and-helpers';
const SCAN_DIRS = ['test', 'evals'];
const SKIP_DIRS = new Set(['node_modules', 'guards']);
const GATE_CALLS = new Set(['skipIf', 'if', 'todoIf', 'runIf']);
const TEST_CALL = /^(describe|test|it)(\.(skip|todo|only|if|skipIf))?$/;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...tsFiles(full));
    } else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** `process.env.NAME` / `process.env['NAME']` → NAME, else null. */
function envName(node: ts.Node): string | null {
  let target: ts.Expression;
  let name: string;
  if (ts.isPropertyAccessExpression(node)) {
    target = node.expression;
    name = node.name.text;
  } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    target = node.expression;
    name = node.argumentExpression.text;
  } else {
    return null;
  }
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'env') return null;
  if (!ts.isIdentifier(target.expression) || target.expression.text !== 'process') return null;
  return name;
}

const isAssignmentTarget = (node: ts.Node): boolean => {
  const parent = node.parent;
  if (ts.isDeleteExpression(parent)) return true;
  return ts.isBinaryExpression(parent)
    && parent.left === node
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
};

const contains = (outer: ts.Node | undefined, inner: ts.Node): boolean =>
  !!outer && inner.pos >= outer.pos && inner.end <= outer.end;

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
  let callee: ts.Expression = call.expression;
  while (ts.isCallExpression(callee)) callee = callee.expression;
  return callee.getText(sf);
}

/** Whether an if-branch stops or selects test execution (return, throw, a test registration, process.exit). */
function branchGates(stmt: ts.Statement | undefined, sf: ts.SourceFile): boolean {
  if (!stmt) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) found = true;
    else if (ts.isCallExpression(node)) {
      const text = calleeText(node, sf);
      if (TEST_CALL.test(text) || text === 'process.exit') found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(stmt);
  return found;
}

const selectsTest = (expr: ts.Expression, sf: ts.SourceFile): boolean =>
  TEST_CALL.test(expr.getText(sf));

/**
 * Whether `node` (an env read, or a reference to a value derived from one)
 * gates execution. Walks up to the enclosing statement; a `const X = <read>`
 * or `return <read>` makes every use of X / the returning function a gate
 * candidate in turn.
 */
function gates(node: ts.Node, sf: ts.SourceFile, seen: Set<string>): boolean {
  for (let child = node, cur = node.parent; cur; child = cur, cur = cur.parent) {
    if (ts.isCallExpression(cur) && cur.arguments.some(a => contains(a, child))) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee) && GATE_CALLS.has(callee.name.text)) return true;
      continue;
    }
    if (ts.isIfStatement(cur) && contains(cur.expression, node)) {
      return branchGates(cur.thenStatement, sf) || branchGates(cur.elseStatement, sf);
    }
    if (ts.isConditionalExpression(cur) && contains(cur.condition, node)) {
      return selectsTest(cur.whenTrue, sf) || selectsTest(cur.whenFalse, sf);
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && contains(cur.initializer, node)) {
      return usesGate(cur.name.text, sf, seen);
    }
    if (ts.isReturnStatement(cur)) {
      const fn = enclosingFunctionName(cur);
      return fn ? usesGate(fn, sf, seen) : false;
    }
    if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return false;
  }
  return false;
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur)) return cur.name?.text ?? null;
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const decl = cur.parent;
      return ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : null;
    }
    if (ts.isFunctionLike(cur)) return null;
  }
  return null;
}

function usesGate(name: string, sf: ts.SourceFile, seen: Set<string>): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name && !isDeclarationName(node) && gates(node, sf, seen)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const isDeclarationName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent))
    && parent.name === node;
};

interface Finding { file: string; line: number; name: string }

function scanFile(path: string): Finding[] {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('GBRAIN_')) return [];
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const assigned = new Set<string>();
  const reads: Array<{ node: ts.Node; name: string }> = [];
  const visit = (node: ts.Node): void => {
    const name = envName(node);
    if (name && name.startsWith('GBRAIN_')) {
      if (isAssignmentTarget(node)) assigned.add(name);
      else reads.push({ node, name });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const findings: Finding[] = [];
  for (const { node, name } of reads) {
    if (!isStripped(name) || assigned.has(name) || PRODUCT.has(name)) continue;
    if (!gates(node, sf, new Set())) continue;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    findings.push({ file: relative(ROOT, path), line, name });
  }
  return findings;
}

function productNames(): Set<string> {
  const names = new Set<string>();
  for (const file of tsFiles(join(ROOT, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bGBRAIN_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  return names;
}

const PRODUCT = productNames();
const findings = SCAN_DIRS.flatMap(dir => tsFiles(join(ROOT, dir))).flatMap(scanFile);
if (findings.length === 0) {
  console.log('✓ test env opt-ins: no test gates execution on a GBRAIN_* name the operator-env scrub strips');
  process.exit(0);
}
for (const f of findings) {
  console.error(`FAIL [test_env_opt_in_stripped]: ${f.file}:${f.line} gates execution on ${f.name}, which the operator-env scrub deletes before tests run, so this gate can never fire.`);
}
console.error('Why: test/helpers/operator-env-preload.ts strips every GBRAIN_* name outside its keep-lists (test/helpers/operator-env-policy.ts); an opt-in under such a name is a silent skip.');
console.error('Fix: rename the opt-in to GBRAIN_TEST_<AREA>_<WHAT> (paid: GBRAIN_TEST_LIVE_<WHAT>) and add the old name to RENAMED in test/helpers/operator-env-policy.ts, or add a KEEP_EXACT row there with its reason. GBRAIN_TEST_KEEP_AMBIENT_ENV=1 disables the scrub for local debugging only.');
console.error(`Docs: ${ANCHOR}`);
process.exit(1);
