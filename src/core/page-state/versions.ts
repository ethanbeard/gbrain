import type { BrainEngine } from '../engine.ts';
import type { PageVersion } from '../types.ts';
import type { PageSnapshot } from './types.ts';

/**
 * Version the same canonical view an API reader receives, including withdrawals.
 * `preimage` (#5984) is the caller's own read of the page under its page guard
 * in this transaction; it is versioned as read, without a second read.
 */
export async function createPageVersion(engine: BrainEngine, slug: string, sourceId: string, preimage?: PageSnapshot): Promise<PageVersion> {
  const insert = async (tx: BrainEngine, snapshot: PageSnapshot) => {
    const { page, tags, revision } = snapshot;
    const rows = await tx.executeRaw<PageVersion>(`INSERT INTO page_versions
      (page_id,compiled_truth,frontmatter,knowledge_revision,timeline,title,type,tags,is_deleted,source_path)
      VALUES ($1,$2,$3::text::jsonb,$4::uuid,$5,$6,$7,$8::text::jsonb,$9,$10) RETURNING *`,
    [page.id, page.compiled_truth, JSON.stringify(page.frontmatter), revision, page.timeline, page.title, page.type, JSON.stringify(tags), page.deleted_at != null, page.source_path ?? null]);
    return { ...rows[0], snapshot_at: new Date(rows[0].snapshot_at) };
  };
  if (preimage) return insert(engine, preimage);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const snapshot = await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (!snapshot) throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
    return insert(tx, snapshot);
  });
}
