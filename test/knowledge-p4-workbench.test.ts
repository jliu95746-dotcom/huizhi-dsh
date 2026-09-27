import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGovernanceWorkbench, renderGovernanceWorkbench,
  type GovernanceWorkbenchData } from '../src/knowledge/workbench.js'
import type { SqlDatabase, VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'

test('中文治理工作台转义来源与原因，只呈现后端审批队列和影响预览', () => {
  const data: GovernanceWorkbenchData = { knowledgeBaseId: 'kb', canReview: true, canPublish: false,
    reviewCases: [{ caseId: 'case-1', kind: 'duplicate', status: 'pending', revision: 1,
      leftRef: 'knowledge:doc:v1:build:a', rightRef: 'knowledge:doc:v2:build:b',
      createdAt: '2026-09-27T00:00:00Z' }],
    proposals: [{ proposalId: 'p-1', status: 'draft', reason: '<script>alert(1)</script>',
      preview: { added: [], removed: [], changed: [], unchanged: [], affectedDerivedIds: ['faq-1'] },
      publishNotBefore: '2026-09-28T00:00:00Z' }] }
  const html = renderGovernanceWorkbench(data)
  assert.match(html, /清洗审核|制度冲突|版本发布/)
  assert.match(html, /faq-1/)
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
  assert.ok(!html.includes('HUIZHI_TASK_CONTEXT_B64'))
})

test('工作台数据按可信租户和知识库读取，无权限者拒绝访问', async () => {
  const calls: unknown[][] = []
  const database: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(_sql: string, params?: unknown[]) => {
      calls.push(params ?? [])
      return { rows: [] as Row[] }
    },
    transaction: async (work) => work(database),
  }
  const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'reviewer' }
  const actor: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] }
  const identity = { verify: async () => actor }
  const data = await loadGovernanceWorkbench(context, 'kb', database, identity)
  assert.equal(data.canReview, true)
  assert.equal(data.canPublish, false)
  assert.deepEqual(calls, [[7, 'kb'], [7, 'kb']])
  actor.permissions = []
  await assert.rejects(loadGovernanceWorkbench(context, 'kb', database, identity), { code: 'ACCESS_DENIED' })
  assert.equal(calls.length, 2)
})
