import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeSearchCache, InMemoryKnowledgeCacheStore } from '../src/knowledge/cache.js'
import type { KnowledgeSearchResult } from '../src/knowledge/query.js'

const context = (who: string) => ({ serviceCredential: who, organizationId: 'org', requesterId: who })
const identity = { verify: async (input: ReturnType<typeof context>) => ({ tenantId: 7,
  organizationId: 'org', requesterId: input.requesterId,
  principals: [{ type: 'user' as const, id: input.requesterId }], permissions: [] }) }
const hit = { documentId: 'doc', version: 'version', buildId: 'build', chunkId: 'chunk',
  title: '制度', content: '住宿上限500元', sourceRef: 'knowledge:doc:version:build:chunk',
  location: { kind: 'page' as const, pageNumber: 1 }, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null,
  evidenceType: 'original_text' as const, conflictStatus: 'none' as const, knowledgeBaseId: 'kb',
  retrievalModes: ['keyword' as const], retrievalScore: 0.8, rerankScore: 0.9 }
const result: KnowledgeSearchResult = { schemaVersion: 1, sourceRef: 'knowledge-query:test',
  version: 'snapshot', status: 'ok', traceId: 'trace', hits: [hit], message: '找到证据',
  diagnostics: { recalled: { keyword: 1, vector: 0, exactNumber: 0 }, authorized: 1,
    filtered: 0, rerankStatus: 'ok', lowRelevance: 0 } }

test('检索缓存按用户、发布和 ACL 隔离，读取时再授权，业务失效时间限制 TTL', async () => {
  let now = new Date('2026-09-27T12:00:00Z')
  let epoch = 1
  let acl = 2
  let allowed = true
  const cache = new KnowledgeSearchCache(new InMemoryKnowledgeCacheStore(), identity,
    { current: async () => ({ releaseId: 'release', epoch, aclRevision: acl,
      nextBoundary: '2026-09-27T12:00:05Z' }) },
    { authorizeRead: async () => { if (!allowed) throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' })
      return { releaseId: 'release', epoch, aclRevision: acl } } }, () => now)
  await cache.put(context('alice'), 'kb', '住宿标准', 'config-a', result)
  const cached = await cache.get({ ...context('alice'), taskId: 'new-task' }, 'kb', '住宿标准', 'config-a')
  assert.equal(cached?.hits.length, 1)
  assert.equal(cached?.traceId, 'new-task')
  assert.notEqual(cached?.sourceRef, result.sourceRef)
  assert.equal(await cache.get(context('bob'), 'kb', '住宿标准', 'config-a'), null)
  assert.equal(await cache.get(context('alice'), 'kb', '住宿标准', 'config-b'), null)
  allowed = false
  assert.equal(await cache.get(context('alice'), 'kb', '住宿标准', 'config-a'), null)
  allowed = true
  acl++
  assert.equal(await cache.get(context('alice'), 'kb', '住宿标准', 'config-a'), null)
  acl--
  epoch++
  assert.equal(await cache.get(context('alice'), 'kb', '住宿标准', 'config-a'), null)
  epoch--
  now = new Date('2026-09-27T12:00:06Z')
  assert.equal(await cache.get(context('alice'), 'kb', '住宿标准', 'config-a'), null)
})

test('未审核 FAQ 不能进入答案缓存；降级和冲突结果也不缓存', async () => {
  const cache = new KnowledgeSearchCache(new InMemoryKnowledgeCacheStore(), identity,
    { current: async () => ({ releaseId: 'release', epoch: 1, aclRevision: 1, nextBoundary: null }) },
    { authorizeRead: async () => ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) })
  await assert.rejects(cache.putFaqAnswer(context('alice'), 'kb', 'faq-1', 'question', 'answer',
    { isApprovedAndReadable: async () => false }), { code: 'FAQ_NOT_APPROVED' })
  assert.equal(await cache.getFaqAnswer(context('alice'), 'kb', 'faq-1', 'question',
    { isApprovedAndReadable: async () => false }), null)
  await cache.put(context('alice'), 'kb', 'q', 'c', { ...result, status: 'degraded' })
  assert.equal(await cache.get(context('alice'), 'kb', 'q', 'c'), null)
})
