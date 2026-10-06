/**
 * #5299: the extract_facts cycle phase fences unfenced fact rows itself.
 *
 * Protects: after ONE cycle, every active `row_num IS NULL` fact on a live
 * entity page is appended to that page's `## Facts` fence with a row number,
 * the DB rows carry those row numbers, the guard count is 0 and the phase
 * reconciles in the same run (status ok, no warning); a second cycle changes
 * nothing. Rows that are structurally unfenceable (no backing page, NULL
 * entity slug) are left exactly as they were. Unmanaged brains write the file
 * and mirror it into `pages`; managed brains publish through the coordinator.
 * Fails when: the phase only counts the rows and skips with a warn telling the
 * operator to re-run the v0.32.2 migration (the pre-#5299 behavior), when a
 * fenced row's number differs between the file and the DB, or when the fence
 * step re-appends rows on a second run.
 * Why existing coverage misses it: the migration tests exercise Phase B
 * directly, and the extract_facts guard tests only cover rows that cannot be
 * fenced (no canonical file).
 * Seams: none; real PGLite (and Postgres through the e2e registration),
 * `runCycle` with `phases: ['extract_facts']`, the shared `managedBrain` and
 * legacy managed fixture.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCycle } from '../src/core/cycle.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';

/** The guard's own predicate: unfenced active rows on a live page of a source with a checkout. */
async function pendingCount(engine: BrainEngine, sourceId = 'default'): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NULL AND f.entity_slug IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = f.source_id AND s.local_path IS NOT NULL)`, [sourceId]);
  return Number(row.n);
}

async function factState(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; entity_slug: string | null; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean }>(
    `SELECT id, entity_slug, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired FROM facts ORDER BY id`);
}

async function extractFactsPhase(engine: BrainEngine, root: string) {
  const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
  return report.phases.find(p => p.phase === 'extract_facts')!;
}

const FENCE_ROW_1 = `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice example joined Acme example | fact | 1.0 | world | high | 2024-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

/** An unmanaged brain whose default source checkout holds one entity page with one indexed fence row, plus unfenced rows. */
async function unmanagedBrain(databaseUrl: string | undefined, run: (brain: { engine: BrainEngine; root: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-unfenced-home-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: `# Alice Example\n\nProse.\n\n${FENCE_ROW_1}` });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
        // The fence row already indexed, as an earlier reconcile left it.
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
           VALUES ('default', $1, 'Alice example joined Acme example', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 1, $1)`, [SLUG]);
        // Rows the inline writer's DB-only fallback produced (row_num NULL).
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
           VALUES ('default', $1, 'Alice example moved to Lisbon', 'fact', 'private', 'medium', '2026-02-05T13:45:12Z', 'mcp:remember', 0.9),
                  ('default', $1, 'Alice example prefers async updates', 'preference', 'private', 'medium', '2026-03-01', 'mcp:remember', 0.8),
                  ('default', 'people-jane-doe', 'Unfenceable: no backing page', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0),
                  ('default', NULL, 'Unfenceable: no entity', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0)`, [SLUG]);
        await run({ engine, root });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: unmanaged: one cycle fences row_num-NULL facts onto the page file, reconciles, and a second cycle changes nothing`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      expect(await pendingCount(engine)).toBe(2);

      const first = await extractFactsPhase(engine, root);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 2, pagesFailed: 0 });
      expect(await pendingCount(engine)).toBe(0);

      const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [1, 'Alice example joined Acme example'],
        [2, 'Alice example moved to Lisbon'],
        [3, 'Alice example prefers async updates'],
      ]);
      // The pages cache carries the same fence, so get_page and the reconcile agree with the file.
      const cached = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(cached.compiled_truth).facts.map(f => f.rowNum)).toEqual([1, 2, 3]);

      const after = await factState(engine);
      expect(after.map(r => [r.fact, r.row_num, r.source_markdown_slug, r.expired])).toEqual([
        ['Alice example joined Acme example', 1, SLUG, false],
        ['Alice example moved to Lisbon', 2, SLUG, false],
        ['Alice example prefers async updates', 3, SLUG, false],
        ['Unfenceable: no backing page', null, null, false],
        ['Unfenceable: no entity', null, null, false],
      ]);

      const second = await extractFactsPhase(engine, root);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0 });
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(file);
      expect(await factState(engine)).toEqual(after);
    });
  }, 120_000);

  test(`${backend}: unmanaged: a page whose canonical file is missing keeps its rows unfenced and is named in the warning`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      rmSync(join(root, `${SLUG}.md`));
      const before = await factState(engine);
      const result = await extractFactsPhase(engine, root);
      expect(result.status).toBe('warn');
      expect(result.summary).toBe('extract_facts skipped: 2 unfenced fact row(s) could not be fenced');
      const warnings = (result.details as { warnings: string[] }).warnings;
      expect(warnings.some(w => w.startsWith(`FACTS_FENCE_FAILED: ${SLUG} (canonical file `) && w.includes('does not exist on this host'))).toBe(true);
      expect(warnings.some(w => w.includes('v0.31') || w.includes('force-retry'))).toBe(false);
      expect(await factState(engine)).toEqual(before);
    });
  }, 120_000);

  test(`${backend}: managed: one cycle fences row_num-NULL facts through the coordinator and a second cycle changes nothing`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine: managed, root: managedRoot }) => {
      expect(await pendingCount(managed)).toBe(3);
      const first = await extractFactsPhase(managed, managedRoot);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 3, pagesFailed: 0 });
      expect(await pendingCount(managed)).toBe(0);

      const rows = await managed.executeRaw<{ id: number; row_num: number; source_markdown_slug: string; expired: boolean }>(
        'SELECT id, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired FROM facts WHERE id = ANY($1::integer[]) ORDER BY id',
        [[...seed.legacyFactIds, ...seed.dbOnlyFactIds]]);
      expect(rows.map(r => [Number(r.id), r.row_num, r.source_markdown_slug, r.expired])).toEqual([
        [seed.legacyFactIds[0], 2, LEGACY_FILE_SLUG, false],
        [seed.legacyFactIds[1], 3, LEGACY_FILE_SLUG, false],
        [seed.dbOnlyFactIds[0], 1, LEGACY_DB_ONLY_SLUG, false],
      ]);
      const file = readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [2, 'Alice example founded Acme example'], [3, 'Alice example moved to Lisbon']]);
      const dbOnly = (await managed.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(dbOnly.page.compiled_truth).facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Dana example advises Widget co']]);

      const facts = await managed.executeRaw('SELECT id, row_num, fact, expired_at FROM facts ORDER BY id');
      const [{ n: requests }] = await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
      const second = await extractFactsPhase(managed, managedRoot);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0 });
      expect(await managed.executeRaw('SELECT id, row_num, fact, expired_at FROM facts ORDER BY id')).toEqual(facts);
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      expect((await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0].n).toBe(requests);
    }, { databaseUrl, setup: async ({ engine: managed, root: managedRoot }) => { seed = await seedLegacyManagedContent(managed, managedRoot); } });
  }, 120_000);
}
