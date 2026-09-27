import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeQueryService, candidateKey, type SearchCandidate } from '../src/knowledge/query.js'
import { validateKnowledgeAnswer } from '../src/knowledge/answer.js'

const owner: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'owner',
  principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish', 'manage_acl', 'revoke'] }
const alice: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'alice',
  principals: [{ type: 'user', id: 'alice' }], permissions: [] }
const identity = { verify: async (context: { serviceCredential: string }) => context.serviceCredential === 'owner' ? owner : alice }
const context = (user: 'owner' | 'alice') => ({ serviceCredential: user, organizationId: 'org', requesterId: user })

async function fixture(t: TestContext) {
  const database = await PGlite.create()
  t.after(async () => database.close())
  await database.exec(await readFile(resolve('plugins/knowledge/migrations/0001_p1_foundation.up.sql'), 'utf8'))
  const sql: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
      ({ rows: (await database.query<Row>(query, params)).rows }),
    transaction: (work) => database.transaction(async (tx) => work({
      query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
        ({ rows: (await tx.query<Row>(query, params)).rows }),
    })),
  }
  return new KnowledgeFoundation(sql, identity, { verify: async () => true }, () => new Date('2026-09-27T12:00:00Z'))
}

test('P1 活动快照过滤旧块，撤销后 P3 答案展示前校验拒绝', async (t) => {
  const foundation = await fixture(t)
  const build = async (revision: string) => {
    const version = await foundation.registerVersion(context('owner'), { knowledgeBaseId: 'kb', sourceSystem: 'test',
      sourceDocumentId: 'policy', sourceRevision: revision, contentHash: revision.repeat(64).slice(0, 64), objectRef: `private://${revision}` })
    const run = await foundation.startBuild(context('owner'), { versionId: version.versionId,
      pipelineFingerprint: `p-${revision}`, idempotencyKey: `run-${revision}` })
    await foundation.completeBuild(context('owner'), { runId: run.runId, generation: run.generation })
    return { ...version, buildId: run.buildId }
  }
  const old = await build('a')
  const current = await build('b')
  await foundation.publish(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'release-new', entries: [{ ...current, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }] })
  await foundation.addAclRule(context('owner'), { knowledgeBaseId: 'kb', resourceType: 'knowledge_base',
    resourceId: 'kb', principalType: 'user', principalId: 'alice', effect: 'allow' })
  const candidate = (version: typeof old): SearchCandidate => ({ tenantId: 7, knowledgeBaseId: 'kb',
    documentId: version.documentId, versionId: version.versionId, buildId: version.buildId,
    chunkId: version.versionId, title: '制度', text: '住宿上限为500元。',
    location: { kind: 'page', pageNumber: 2 }, evidenceType: 'original_text', conflictStatus: 'none',
    effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: null, score: 0.8 })
  const seen: string[] = []
  const service = new KnowledgeQueryService(identity, foundation, {
    keyword: async () => [candidate(old), candidate(current)], vector: async () => [], exactNumber: async () => [],
  }, { rerank: async (_question, items) => { seen.push(...items.map((item) => item.versionId));
    return items.map((item) => ({ candidateKey: candidateKey(item), score: 0.9 })) } }, undefined,
  { allow: async () => true })
  const result = await service.search(context('alice'), '住宿上限？')
  assert.deepEqual(seen, [current.versionId])
  assert.deepEqual(result.hits.map((hit) => hit.version), [current.versionId])
  assert.equal(result.hits[0].effectiveFrom, '2026-01-01T00:00:00.000Z')
  await foundation.revokeVersion(context('owner'), { versionId: current.versionId, reason: '紧急撤销' })
  assert.deepEqual(await validateKnowledgeAnswer(context('alice'), result,
    `住宿上限为500元。[${result.hits[0].sourceRef}]`, service), { ok: false, reason: 'SOURCE_REVOKED' })
})
