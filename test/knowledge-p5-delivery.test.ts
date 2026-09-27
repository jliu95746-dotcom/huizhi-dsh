import assert from 'node:assert/strict'
import test from 'node:test'
import { executeVerifiedKnowledgeTask } from '../src/knowledge/dsh-integration.js'

test('DSH 拒答也记录可信交付追踪，记录失败不伪装成已交付', async () => {
  const calls: unknown[] = []
  const task = { version: 1 as const, taskId: 'task-1', organizationId: 'org',
    requesterId: 'alice', prompt: '当前规则是什么？', capabilities: ['knowledge' as const] }
  const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'alice', taskId: 'task-1' }
  const input = { task, context, knowledgeBaseId: 'kb',
    knowledge: { search: async () => ({ schemaVersion: 1 as const,
      sourceRef: 'knowledge-query:none', version: 'none', status: 'no_evidence' as const,
      traceId: 'task-1', hits: [], message: '资料不足',
      diagnostics: { recalled: { keyword: 0, vector: 0, exactNumber: 0 }, authorized: 0,
        filtered: 0, rerankStatus: 'skipped' as const, lowRelevance: 0 } }),
      authorizeCitation: async () => false },
    generationPolicy: { allow: async () => false },
    deliveryRecorder: { recordDelivery: async (_context: unknown, receipt: unknown) => {
      calls.push(receipt)
      return { receiptId: 'receipt-1' }
    } },
  }
  const result = await executeVerifiedKnowledgeTask(input)
  assert.equal(result.status, 'rejected')
  assert.deepEqual(calls, [{ knowledgeBaseId: 'kb', traceId: 'task-1',
    question: task.prompt, status: 'rejected', sourceRefs: [], searchVersion: 'none' }])
  await assert.rejects(executeVerifiedKnowledgeTask({ ...input,
    deliveryRecorder: { recordDelivery: async () => { throw new Error('receipt unavailable') } } }),
  /receipt unavailable/)
})
