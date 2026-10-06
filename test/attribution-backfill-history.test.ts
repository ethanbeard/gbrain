/**
 * Foundations 2 (Lane C): `gbrain repair attribution-backfill` on a managed
 * brain with real journaled history (pages created, edited, deleted and
 * restored; facts remembered and forgotten), after the attribution of most
 * rows is reset to the pre-attribution state. Checks that the backfill fills
 * exactly the rows a committed request proves, back to the attribution the
 * coordinator wrote; leaves every other row `unrecorded`; and leaves canonical
 * content, revisions and rows that already carried attribution unchanged.
 * Prints the preview and apply counts (`GBRAIN_TEST_BACKFILL_FIXTURE_PAGES` sizes
 * the fixture; 40 pages by default).
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { WRITE_ATTRIBUTION_CONTENT_COLUMNS } from '../src/core/persistence/attribution-schema.ts';
import { buildAttributionHistory } from './helpers/attribution-history-fixture.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';

const PAGES = Number(process.env.GBRAIN_TEST_BACKFILL_FIXTURE_PAGES ?? 40);

interface RepairResult { affected: number; applied: number; complete: boolean; residuals: Record<string, number> }
async function repair(engine: BrainEngine, args: string[]): Promise<RepairResult> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['attribution-backfill', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')).results[0] as RepairResult;
}

const CONTENT = {
  pages: 'id, slug, type, title, compiled_truth, timeline, frontmatter::text AS frontmatter, content_hash, knowledge_revision::text AS revision, deleted_at::text AS deleted_at',
  page_versions: 'id, page_id, compiled_truth, frontmatter::text AS frontmatter, knowledge_revision::text AS revision',
  facts: WRITE_ATTRIBUTION_CONTENT_COLUMNS.facts.map(column => `${column}::text AS ${column}`).join(', '),
};
const FILLED = {
  pages: ['revision_write_request_id', 'revision_principal_kind', 'revision_principal_id'],
  page_versions: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
  facts: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
} as const;
const OTHER = {
  pages: [] as string[],
  page_versions: ['archived_write_request_id', 'archived_principal_kind', 'archived_principal_id'],
  facts: ['last_write_request_id', 'last_write_principal_kind', 'last_write_principal_id', 'last_written_at'],
};
type Table = keyof typeof CONTENT;
const TABLES: Table[] = ['pages', 'page_versions', 'facts'];
const scope = (table: Table) => table === 'page_versions' ? 'page_id IN (SELECT id FROM pages WHERE source_id=\'default\')' : 'source_id=\'default\'';
const read = (engine: BrainEngine, table: Table, columns: string) =>
  engine.executeRaw<Record<string, unknown>>(`SELECT ${columns} FROM ${table} WHERE ${scope(table)} ORDER BY id`);
const attribution = (engine: BrainEngine, table: Table) =>
  read(engine, table, ['id', ...[...FILLED[table], ...OTHER[table]].map(column => `${column}::text AS ${column}`)].join(', '));
const filled = (row: Record<string, unknown>, table: Table) => FILLED[table].some(column => row[column] !== null);

for (const backend of testBackends()) {
  describe(`attribution-backfill on a managed history fixture (${backend})`, () => {
    test('fills exactly the journal-proven rows and changes no content, revision or existing attribution', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const history = await buildAttributionHistory(ctx, PAGES);
        const content = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await read(engine, table, CONTENT[table])])));
        const original = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await attribution(engine, table)])));
        const kept = (id: unknown) => Number(id) % 4 === 0;

        await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL session_replication_role = replica');
          for (const table of TABLES) {
            await tx.executeRaw(`UPDATE ${table} SET ${[...FILLED[table], ...OTHER[table]].map(column => `${column}=NULL`).join(', ')}
              WHERE ${scope(table)} AND id % 4 <> 0`);
          }
        });
        const reset = Object.fromEntries(TABLES.map(table => [table, (original[table] as Array<Record<string, unknown>>).filter(row => !kept(row.id) && filled(row, table)).length]));

        const preview = await repair(engine, []);
        const applied = await repair(engine, ['--apply']);
        const after = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await attribution(engine, table)])));
        const counts = Object.fromEntries(TABLES.map(table => {
          const rows = after[table] as Array<Record<string, unknown>>;
          return [table, { rows: rows.length, reset: reset[table], refilled: rows.filter(row => !kept(row.id) && filled(row, table)).length,
            unrecorded: rows.filter(row => !filled(row, table)).length }];
        }));
        console.error(`[attribution-backfill-fixture] ${JSON.stringify({ backend, history, preview: { affected: preview.affected, residuals: preview.residuals },
          apply: { applied: applied.applied, complete: applied.complete }, counts })}`);

        expect(applied.complete).toBe(true);
        expect((await repair(engine, ['--apply'])).applied).toBe(0);
        for (const table of TABLES) {
          expect(await read(engine, table, CONTENT[table])).toEqual(content[table]);
          const before = new Map((original[table] as Array<Record<string, unknown>>).map(row => [row.id, row]));
          for (const row of after[table] as Array<Record<string, unknown>>) {
            const was = before.get(row.id)!;
            if (kept(row.id)) { expect(row).toEqual(was); continue; }
            for (const column of OTHER[table]) expect(row[column]).toBeNull();
            if (filled(row, table)) for (const column of FILLED[table]) expect(row[column]).toEqual(was[column]);
          }
        }
        expect(counts.pages.refilled).toBeGreaterThan(0);
        expect(counts.page_versions.refilled).toBeGreaterThan(0);
        expect(counts.facts.refilled).toBeGreaterThan(0);
      }, backend === 'postgres' ? { databaseUrl: requirePostgresTestDatabase() } : {});
    }, Math.max(600_000, PAGES * 1_000));
  });
}
