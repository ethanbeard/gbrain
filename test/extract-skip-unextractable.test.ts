import { expect, spyOn, test } from 'bun:test';
import { extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

async function makeEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function putLinkFixture(engine: PGLiteEngine): Promise<void> {
  await engine.setConfig('mentions.auto_link', 'false');
  await engine.putPage('people/hub-a', { type: 'person', title: 'Hub A', compiled_truth: 'Hub A.' });
  await engine.putPage('people/hub-b', { type: 'person', title: 'Hub B', compiled_truth: 'Hub B.' });
  await engine.putPage('people/p1', { type: 'person', title: 'P1', compiled_truth: 'Knows [[people/hub-a]].' });
  await engine.putPage('people/p2', { type: 'person', title: 'P2', compiled_truth: 'Knows [[people/hub-b]].' });
}

async function outgoing(engine: PGLiteEngine, slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT t.slug FROM links l
      JOIN pages f ON f.id=l.from_page_id
      JOIN pages t ON t.id=l.to_page_id
      WHERE f.source_id='default' AND f.slug=$1
      ORDER BY t.slug`, [slug],
  );
  return rows.map(row => row.slug);
}

async function stamp(engine: PGLiteEngine, slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE source_id='default' AND slug=$1`, [slug],
  );
  return rows[0]?.links_extracted_at ?? null;
}

function reviseHubAOnP1(engine: PGLiteEngine): () => void {
  const original = engine.replaceDerivedLinks;
  let revised = false;
  engine.replaceDerivedLinks = async (origin, links, opts) => {
    if (!revised && origin.slug === 'people/p1') {
      revised = true;
      await engine.putPage('people/hub-a', { type: 'person', title: 'Hub A', compiled_truth: 'Hub A revised.' });
    }
    return original.call(engine, origin, links, opts);
  };
  return () => { engine.replaceDerivedLinks = original; };
}

test('stale extraction skips one endpoint revision conflict and continues with later pages', async () => {
  const engine = await makeEngine();
  try {
    await putLinkFixture(engine);
    const restore = reviseHubAOnP1(engine);
    const first = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: false, includeFrontmatter: false, catchUp: true,
    });
    expect(first.skippedEndpointChanged).toBe(1);
    expect(await outgoing(engine, 'people/p1')).toEqual([]);
    expect(await stamp(engine, 'people/p1')).toBeNull();
    expect(await outgoing(engine, 'people/p2')).toEqual(['people/hub-b']);
    expect(await stamp(engine, 'people/p2')).not.toBeNull();

    restore();
    const second = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: false, includeFrontmatter: false, catchUp: true,
    });
    expect(second.skippedEndpointChanged).toBe(0);
    expect(await outgoing(engine, 'people/p1')).toEqual(['people/hub-a']);
    expect(await stamp(engine, 'people/p1')).not.toBeNull();
  } finally {
    await engine.disconnect();
  }
}, 120_000);

test('full DB link extraction reports an endpoint revision conflict and continues', async () => {
  const engine = await makeEngine();
  try {
    await putLinkFixture(engine);
    const restore = reviseHubAOnP1(engine);
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    try {
      await runExtract(engine, ['links', '--source', 'db', '--json']);
    } finally {
      logSpy.mockRestore();
      restore();
    }
    expect(logs.join('\n')).toContain('"skipped_endpoint_changed": 1');
    expect(await outgoing(engine, 'people/p1')).toEqual([]);
    expect(await outgoing(engine, 'people/p2')).toEqual(['people/hub-b']);
  } finally {
    await engine.disconnect();
  }
}, 120_000);

test('invalid body slug refs do not block valid links or wanted mixed-case slugs', async () => {
  const engine = await makeEngine();
  try {
    await engine.setConfig('mentions.auto_link', 'false');
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob',
      compiled_truth: 'Knows [[https://x.com/a|b]] and [[people/alice]] and [[People/Missing-Person]].' });
    await expect(extractStaleFromDB(engine, {
      dryRun: false, jsonMode: false, includeFrontmatter: false, catchUp: true,
    })).resolves.toBeDefined();
    expect(await outgoing(engine, 'people/bob')).toEqual(['people/alice']);
    expect(await stamp(engine, 'people/bob')).not.toBeNull();
    const wanted = await engine.executeRaw<{ target_ref: string }>(
      `SELECT target_ref FROM wanted_links w
        JOIN pages p ON p.id=w.origin_page_id
        WHERE p.source_id='default' AND p.slug='people/bob'
        ORDER BY target_ref`,
    );
    expect(wanted.some(row => row.target_ref.includes('x.com'))).toBe(false);
    expect(wanted.map(row => row.target_ref)).toContain('People/Missing-Person');
  } finally {
    await engine.disconnect();
  }
}, 120_000);
