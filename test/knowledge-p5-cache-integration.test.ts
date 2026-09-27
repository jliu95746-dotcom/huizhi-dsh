import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeGovernance } from '../src/knowledge/governance.js'
import { InMemoryKnowledgeCacheStore, KnowledgeFaqApproval, KnowledgeSearchCache,
  PostgresKnowledgeCacheSnapshot } from '../src/knowledge/cache.js'

const actors: Record<string, VerifiedKnowledgeActor> = {
  owner: { tenantId: 7, organizationId: 'org', requesterId: 'owner',
    principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish', 'manage_acl', 'revoke'] },
  reviewer: { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] },
  alice: { tenantId: 7, organizationId: 'org', requesterId: 'alice',
    principals: [{ type: 'user', id: 'alice' }], permissions: [] },
}
const identity = { verify: async (input: { serviceCredential: string }) => actors[input.serviceCredential] }
const context = (who: keyof typeof actors) => ({ serviceCredential: who,
  organizationId: 'org', requesterId: who })
async function fixture(t: TestContext) {
  const db = await PGlite.create()
  t.after(async () => db.close())
  for (const migration of ['0001_p1_foundation.up.sql', '0002_p2_staged_index.up.sql',
    '0003_p4_governance.up.sql']) {
    await db.exec(await readFile(resolve('plugins/knowledge/migrations', migration), 'utf8'))
  }
  const sql: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
      ({ rows: (await db.query<Row>(query, params)).rows }),
    transaction: (work) => db.transaction(async (tx) => work({
      query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
        ({ rows: (await tx.query<Row>(query, params)).rows }),
    })),
  }
  const now = () => new Date('2026-09-27T12:00:00Z')
  const foundation = new KnowledgeFoundation(sql, identity, { verify: async () => true }, now)
  const governance = new KnowledgeGovernance(sql, identity, foundation,
    { loadText: async () => null }, now)
  const version = await foundation.registerVersion(context('owner'), { knowledgeBaseId: 'kb',
    sourceSystem: 'test', sourceDocumentId: 'policy', sourceRevision: 'v1',
    contentHash: 'a'.repeat(64), objectRef: 'private://policy-v1' })
  const build = await foundation.startBuild(context('owner'), { versionId: version.versionId,
    pipelineFingerprint: 'p1', idempotencyKey: 'build-1' })
  await foundation.completeBuild(context('owner'), { runId: build.runId, generation: build.generation })
  for (const who of ['owner', 'reviewer', 'alice'] as const) {
    await foundation.addAclRule(context('owner'), { knowledgeBaseId: 'kb',
      resourceType: 'knowledge_base', resourceId: 'kb', principalType: 'user', principalId: who,
      effect: 'allow' })
  }
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'release-1', reason: '初版',
    entries: [{ ...version, buildId: build.buildId,
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-09-28T00:00:00Z' }] })
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '已核对')
  const release = await governance.publishApproved(context('owner'), proposal.proposalId)
  await db.exec(await readFile(resolve('plugins/knowledge/migrations',
    '0004_p5_feedback_operations.up.sql'), 'utf8'))
  return { sql, foundation, governance, version, build, release, now }
}

test('真实快照读取下一业务边界；FAQ 人工审批后缓存仍逐次检查撤销', async (t) => {
  const { sql, foundation, governance, version, build, release, now } = await fixture(t)
  const snapshotProvider = new PostgresKnowledgeCacheSnapshot(sql, identity, now)
  const snapshot = await snapshotProvider.current(context('alice'), 'kb')
  assert.equal(snapshot.releaseId, release.releaseId)
  assert.equal(snapshot.nextBoundary, '2026-09-28T00:00:00.000Z')
  const derived = await governance.registerDerived(context('owner'), { knowledgeBaseId: 'kb',
    kind: 'faq', objectRef: 'private://faq-a',
    sources: [`knowledge:${version.documentId}:${version.versionId}:${build.buildId}:chunkA`] })
  const approval = new KnowledgeFaqApproval(sql, identity, governance)
  assert.equal(await approval.isApprovedAndReadable(context('alice'), 'kb', derived.assetId), false)
  await assert.rejects(approval.approve(context('owner'), derived.assetId), { code: 'ACCESS_DENIED' })
  await approval.approve(context('reviewer'), derived.assetId)
  const cache = new KnowledgeSearchCache(new InMemoryKnowledgeCacheStore(), identity,
    snapshotProvider, foundation, now)
  await cache.putFaqAnswer(context('alice'), 'kb', derived.assetId, '住宿标准？', '住宿上限500元。', approval)
  assert.equal(await cache.getFaqAnswer(context('alice'), 'kb', derived.assetId, '住宿标准？', approval),
    '住宿上限500元。')
  await foundation.revokeVersion(context('owner'), { versionId: version.versionId, reason: '紧急撤销' })
  assert.equal(await cache.getFaqAnswer(context('alice'), 'kb', derived.assetId, '住宿标准？', approval), null)
})
