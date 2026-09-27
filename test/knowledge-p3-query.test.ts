import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeQueryService, candidateKey, planKnowledgeQuery, type SearchCandidate } from '../src/knowledge/query.js'
import { buildKnowledgePrompt, validateKnowledgeAnswer } from '../src/knowledge/answer.js'
import type { KnowledgeIdentityVerifier, UntrustedKnowledgeContext } from '../src/knowledge/foundation.js'

const context: UntrustedKnowledgeContext = { serviceCredential: 'verified-service', organizationId: 'org', requesterId: 'alice', taskId: 'task-1' }
const identity: KnowledgeIdentityVerifier = { verify: async () => ({ tenantId: 7, organizationId: 'org', requesterId: 'alice',
  principals: [{ type: 'user', id: 'alice' }], permissions: [] }) }
const modelPolicy = { allow: async () => true }
const candidate = (id: string, overrides: Partial<SearchCandidate> = {}): SearchCandidate => ({
  tenantId: 7, knowledgeBaseId: 'kb', documentId: id, versionId: `${id}-v1`, buildId: `${id}-build`, chunkId: `${id}-chunk`,
  title: '差旅制度', text: '2026年9月起，差旅住宿上限为500元。', location: { kind: 'page', pageNumber: 3 },
  evidenceType: 'original_text', conflictStatus: 'none', effectiveFrom: '2026-09-01T00:00:00Z', effectiveTo: null,
  score: 0.8, ...overrides,
})

test('查询规划保留时间、部门和编号约束，指代不明则澄清', () => {
  const plan = planKnowledgeQuery('2026年9月法务部合同 HT-2026-18 的付款规则是什么？')
  assert.equal(plan.intent, 'explain')
  assert.match(plan.documentNumber ?? '', /HT-2026-18/)
  assert.ok(plan.queries.every((query) => query.includes('2026年9月') && query.includes('法务部') && query.includes('HT-2026-18')))
  assert.equal(planKnowledgeQuery('它的规定是什么？').needsClarification, true)
  assert.equal(planKnowledgeQuery('2025年住宿上限是多少？', new Date('2026-09-27T12:00:00Z')).clarificationReason, 'historical_time')
})

test('跨路候选先鉴权再重排，过期、跨租户和未授权正文不进入模型', async () => {
  const good = candidate('good')
  const secret = candidate('secret', { text: '未授权合同金额为100万元。' })
  const stale = candidate('stale')
  const foreign = candidate('foreign', { tenantId: 8 })
  const seen: string[][] = []
  const authorized: string[] = []
  const service = new KnowledgeQueryService(identity, { authorizeRead: async (_context, item) => {
    authorized.push(`${item.surface}:${item.documentId}`)
    if (item.documentId !== 'good') throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' })
    return { releaseId: 'release-1', epoch: 2, aclRevision: 3 }
  } }, {
    keyword: async () => [good, secret, stale, foreign], vector: async () => [good], exactNumber: async () => [],
  }, { rerank: async (_query, items) => { seen.push(items.map((item) => item.text)); return items.map((item) => ({ candidateKey: candidateKey(item), score: 0.9 })) } }, undefined, modelPolicy)
  const result = await service.search(context, '差旅住宿上限是多少？')
  assert.equal(result.status, 'ok')
  assert.equal(result.hits.length, 1)
  assert.deepEqual(seen, [[good.text]])
  assert.ok(!authorized.some((entry) => entry.includes('foreign')))
  assert.ok(authorized.includes('search:good') && authorized.includes('original:good') && authorized.includes('citation:good'))
  assert.deepEqual(result.hits[0].location, { kind: 'page', pageNumber: 3 })
})

test('严格模式重排故障、低分与冲突返回明确状态', async () => {
  const make = (rerank: { rerank: (_query: string, items: SearchCandidate[]) => Promise<Array<{ candidateKey: string; score: number }>> },
    items = [candidate('good')]) => new KnowledgeQueryService(identity, { authorizeRead: async () =>
    ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) }, {
    keyword: async () => items, vector: async () => [], exactNumber: async () => [],
  }, rerank, undefined, modelPolicy)
  assert.equal((await make({ rerank: async () => { throw new Error('429') } }).search(context, '上限？')).status, 'degraded')
  assert.equal((await make({ rerank: async (_q, items) => items.map((item) => ({ candidateKey: candidateKey(item), score: 0.1 })) })
    .search(context, '上限？')).status, 'no_evidence')
  const conflict = candidate('good', { conflictStatus: 'unresolved' })
  assert.equal((await make({ rerank: async (_q, items) => items.map((item) => ({ candidateKey: candidateKey(item), score: 0.9 })) }, [conflict])
    .search(context, '上限？')).status, 'unresolved_conflict')
})

test('父块单独鉴权，输出前撤权清除证据；答案引用和关键数字严格校验', async () => {
  let outputAllowed = true
  const service = new KnowledgeQueryService(identity, { authorizeRead: async (_context, item) => {
    if (item.surface === 'parent') throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' })
    if (item.surface === 'citation' && !outputAllowed) throw Object.assign(new Error('revoked'), { code: 'ACCESS_DENIED' })
    return { releaseId: 'release', epoch: 1, aclRevision: 1 }
  } }, { keyword: async () => [candidate('good', { parentId: 'parent-1' })], vector: async () => [], exactNumber: async () => [] },
  { rerank: async (_q, items) => items.map((item) => ({ candidateKey: candidateKey(item), score: 0.9 })) },
  { getParent: async () => ({ ...candidate('good'), chunkId: 'parent-1', text: '不得超过500元。' }) }, modelPolicy)
  const result = await service.search(context, '差旅住宿上限是多少？')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].content, candidate('good').text)
  const prompt = buildKnowledgePrompt('差旅住宿上限是多少？', result)
  assert.ok(prompt.includes(result.hits[0].sourceRef))
  assert.equal((await validateKnowledgeAnswer(context, result, `上限为500元。[${result.hits[0].sourceRef}]`, service)).ok, true)
  assert.equal((await validateKnowledgeAnswer(context, result, '上限为600元。[fake]', service)).ok, false)
  assert.deepEqual(await validateKnowledgeAnswer(context, result,
    `上限为500元。[${result.hits[0].sourceRef}] 另一条上限为600元。`, service),
  { ok: false, reason: 'UNCITED_CLAIM' })
  outputAllowed = false
  assert.equal((await validateKnowledgeAnswer(context, result, `上限为500元。[${result.hits[0].sourceRef}]`, service)).ok, false)
})

test('相同 chunkId 的不同文档以完整来源键重排，不合并来源', async () => {
  const a = candidate('a', { chunkId: 'shared' })
  const b = candidate('b', { chunkId: 'shared' })
  const service = new KnowledgeQueryService(identity, { authorizeRead: async () =>
    ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) }, {
    keyword: async () => [a, b], vector: async () => [], exactNumber: async () => [],
  }, { rerank: async (_query, items) => items.map((item) => ({ candidateKey: candidateKey(item), score: 0.9 })) },
  undefined, modelPolicy)
  const result = await service.search(context, '规则是什么？')
  assert.equal(result.hits.length, 2)
  assert.notEqual(result.hits[0].sourceRef, result.hits[1].sourceRef)
})
