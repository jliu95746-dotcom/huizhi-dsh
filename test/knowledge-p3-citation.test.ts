import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeCitationResolver } from '../src/knowledge/citation.js'
import type { SearchCandidate } from '../src/knowledge/query.js'

const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'alice' }
const identity = { verify: async () => ({ tenantId: 7, organizationId: 'org', requesterId: 'alice',
  principals: [{ type: 'user' as const, id: 'alice' }], permissions: [] }) }
const original: SearchCandidate = { tenantId: 7, knowledgeBaseId: 'kb', documentId: 'doc', versionId: 'v1',
  buildId: 'build', chunkId: 'chunk', title: '制度', text: '原文：住宿上限为500元。',
  location: { kind: 'page', pageNumber: 2 }, evidenceType: 'original_text', conflictStatus: 'none',
  effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, score: 1 }

test('引用按精确版本与片段重新打开，撤权后不能读取', async () => {
  let allowed = true
  const resolver = new KnowledgeCitationResolver(identity, { authorizeRead: async () => {
    if (!allowed) throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' })
    return { releaseId: 'release', epoch: 1, aclRevision: 1,
      effectiveFrom: '2026-02-01T00:00:00Z', effectiveTo: null }
  } }, { getMetadata: async () => original, getOriginal: async () => ({ text: original.text, location: original.location }) })
  const opened = await resolver.open(context, 'knowledge:doc:v1:build:chunk')
  assert.equal(opened.content, original.text)
  assert.deepEqual(opened.location, original.location)
  assert.equal(opened.effectiveFrom, '2026-02-01T00:00:00Z')
  allowed = false
  await assert.rejects(resolver.open(context, 'knowledge:doc:v1:build:chunk'), { code: 'ACCESS_DENIED' })
})

test('引用解析拒绝错配和未发布来源，不能用来源串直接读取索引原文', async () => {
  const resolver = new KnowledgeCitationResolver(identity, { authorizeRead: async () =>
    ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) }, {
    getMetadata: async () => original, getOriginal: async () => ({ text: original.text, location: original.location }),
  })
  await assert.rejects(resolver.open(context, 'knowledge:other:v1:build:chunk'), { code: 'ACCESS_DENIED' })
  await assert.rejects(resolver.open(context, 'knowledge-query:snapshot'), { code: 'INVALID_SOURCE_REF' })
})
