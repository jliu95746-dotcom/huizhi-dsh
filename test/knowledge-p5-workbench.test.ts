import assert from 'node:assert/strict'
import test from 'node:test'
import { loadFeedbackWorkbench, renderFeedbackWorkbench,
  type FeedbackWorkbenchData } from '../src/knowledge/feedback-workbench.js'
import type { SqlDatabase, VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'

test('中文反馈评测台安全转义员工内容并展示失败回归', () => {
  const data: FeedbackWorkbenchData = { knowledgeBaseId: 'kb', datasetRevision: 2,
    feedback: [{ id: 'f1', category: 'conflict', status: 'pending',
      comment: '<img src=x onerror=alert(1)>', traceId: 'task-1', createdAt: '2026-09-27T00:00:00Z' }],
    runs: [{ id: 'r1', status: 'failed', caseCount: 2, configFingerprint: 'cfg-1',
      approvedBy: null, createdAt: '2026-09-27T00:00:00Z' }] }
  const html = renderFeedbackWorkbench(data)
  assert.match(html, /反馈审核|回归评测|数据集版本/)
  assert.match(html, /&lt;img/)
  assert.ok(!html.includes('<img src=x'))
  assert.match(html, /cfg-1/)
})

test('反馈台按可信租户读取且仅审核人可见', async () => {
  const calls: unknown[][] = []
  const database: SqlDatabase = { query: async <Row extends Record<string, unknown>>(
    _query: string, params?: unknown[]) => {
    calls.push(params ?? [])
    return { rows: [] as Row[] }
  }, transaction: async (work) => work(database) }
  const actor: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] }
  const identity = { verify: async () => actor }
  const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'reviewer' }
  const data = await loadFeedbackWorkbench(context, 'kb', database, identity)
  assert.equal(data.datasetRevision, 0)
  assert.deepEqual(calls, [[7, 'kb'], [7, 'kb'], [7, 'kb']])
  actor.permissions = []
  await assert.rejects(loadFeedbackWorkbench(context, 'kb', database, identity),
    { code: 'ACCESS_DENIED' })
})
