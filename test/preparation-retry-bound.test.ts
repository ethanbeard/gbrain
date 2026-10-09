import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { executeClaimedGroup } from '../src/core/persistence/group-publish.ts';
import { renewGroupClaims, receiptFor } from '../src/core/persistence/journal.ts';
import { frozenVerbWriteError } from '../src/core/persistence/verb-errors.ts';
import { holdRepairSteps } from '../src/core/persistence/sync-holds.ts';
import { recordRoute } from '../src/core/persistence/held-reads.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-preparation-bound-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => resetPgliteState(engine));

async function rows(count = 4): Promise<WriteRequest[]> {
  const id = `bound-${randomUUID().replaceAll('-', '').slice(0, 16)}`; const root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nBody ${i}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root); await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true }); await disposePersistenceConsumer(engine);
  const got = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),completed_at=NULL,published_at=NULL,
    error_code=NULL,error_message=NULL,claim_phase=NULL,claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL
    WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' RETURNING *`, [id]);
  got.sort((a,b) => Number(a.sequence)-Number(b.sequence));
  const bytes = got.reduce((n,r)=>n+Number(r.intent_bytes),0);
  await engine.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+$2,intent_bytes=intent_bytes+$3 WHERE key=ANY($1::text[])',
    [['brain', principalKey(requestPrincipal(got[0]!))], got.length, bytes]);
  return got;
}
const execute = (rs: WriteRequest[], prepare: Parameters<typeof executeClaimedGroup>[2]['prepare']) => executeClaimedGroup(engine, rs,
  { hostId: randomUUID(), settled() {}, prepare, preparationMs: 60, lease: { everyMs: 10, deadlineMs: 500 } });
async function reclaim(rs: WriteRequest[]): Promise<WriteRequest[]> {
  const got = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),
    claim_expires_at=now()+interval '5 minutes',blocked_reason=NULL WHERE id=ANY($1::uuid[]) AND state='queued' RETURNING *`, [rs.map(r=>r.id)]);
  got.sort((a,b)=>Number(a.sequence)-Number(b.sequence)); return got;
}

 test('started and unsettled members fail on exactly the third deadline and surface the public code', async () => {
  let rs = await rows();
  for (let attempt=1; attempt<=3; attempt++) {
    expect(await execute(rs, () => new Promise(() => {}))).toBe(false);
    const got = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence',[rs.map(r=>r.id)]);
    expect(got.every(r => Number(((r as WriteRequest & { claim_phase?: Record<string, unknown> }).claim_phase)?.preparation_abandoned)===attempt)).toBe(true);
    if (attempt<3) { expect(got.every(r=>r.state==='queued' && r.blocked_reason==='preparation_deadline')).toBe(true); rs=await reclaim(rs); }
    else {
      expect(got.every(r=>r.state==='failed' && r.error_code==='preparation_abandoned_3x')).toBe(true);
      expect(got[0]!.error_message).toContain(got[0]!.slug!); expect(got[0]!.error_message).toContain(got[0]!.request_id);
      expect(frozenVerbWriteError(receiptFor(got[0]!), 'preparation_abandoned_3x').writeError).toBe('preparation_abandoned_3x');
    }
  }
});

test('settled members do not receive a strike and an abort-aware stuck member does', async () => {
  let rs = await rows(); const ids=rs.map(r=>r.id); const stuckId=rs[0]!.id;
  for (let attempt=1; attempt<=3; attempt++) {
    await execute(rs, (row, _reads, signal) => row.id===stuckId ? new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})) : Promise.reject(new Error('fast')));
    const got = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence',[ids]);
    expect(((got[1]! as WriteRequest & { claim_phase?: Record<string, unknown> }).claim_phase)?.preparation_abandoned).toBeUndefined();
    if (attempt<3) rs=await reclaim([got[0]!]); else expect(got[0]).toMatchObject({state:'failed',error_code:'preparation_abandoned_3x'});
  }
});

test('renewal preserves the durable strike and preparation holds route only to retry-held', async () => {
  let rs=await rows(1); await execute(rs,()=>new Promise(()=>{})); rs=await reclaim(rs);
  const renewed=await renewGroupClaims(engine,rs,30_000,undefined,JSON.stringify({phase:'preparing',since:new Date().toISOString(),progress:0}));
  expect(renewed.has(rs[0]!.id)).toBe(true);
  const [got]=await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid',[rs[0]!.id]);
  expect((got! as WriteRequest & { claim_phase: Record<string, unknown> }).claim_phase.preparation_abandoned).toBe(1);
  const route=recordRoute({code:'preparation_abandoned_3x'}); const steps=holdRepairSteps(got!.source_id,route);
  expect(steps.argv).toEqual(['gbrain','sources','retry-held',got!.source_id]); expect(steps.commands.join(' ')).not.toContain('repair frontmatter');
});
