import assert from 'node:assert/strict'
import test from 'node:test'
import { executeVerifiedKnowledgeTask } from '../src/knowledge/dsh-integration.js'
import type { TaskRequest } from '../src/contracts.js'
import type { KnowledgeSearchResult } from '../src/knowledge/query.js'

const task: TaskRequest = { version: 1, taskId: 'task-1', organizationId: 'org', requesterId: 'alice',
  prompt: '住宿上限是多少？', capabilities: ['knowledge'] }
const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'alice', taskId: 'task-1' }
const sourceRef = 'knowledge:doc:v1:build:chunk'
const search: KnowledgeSearchResult = { schemaVersion: 1, sourceRef: 'knowledge-query:snapshot', version: 'snap',
  status: 'ok', traceId: 'task-1', message: '已找到可核验的资料。',
  diagnostics: { recalled: { keyword: 1, vector: 0, exactNumber: 0 }, authorized: 1, filtered: 0,
    rerankStatus: 'ok', lowRelevance: 0 },
  hits: [{ documentId: 'doc', version: 'v1', buildId: 'build', chunkId: 'chunk', title: '制度',
    content: '住宿上限为500元。', sourceRef, location: { kind: 'page', pageNumber: 2 },
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, evidenceType: 'original_text',
    conflictStatus: 'none', knowledgeBaseId: 'kb', retrievalModes: ['keyword'], retrievalScore: 0.8, rerankScore: 0.9 }] }

test('DSH completed 事件先拦截，只有工具来源和答案校验通过才交付', async () => {
  const events: string[] = []
  const result = await executeVerifiedKnowledgeTask({ task, context,
    knowledge: { search: async () => search, authorizeCitation: async () => true },
    generationPolicy: { allow: async () => true },
    runModel: async (request, options) => {
      assert.ok(request.prompt.includes(sourceRef))
      options.onEvent?.({ type: 'completed', taskId: 'task-1', response: '泄露草稿',
        artifacts: [], toolCalls: [], sourceRefs: [], sessionId: 's' })
      return { type: 'completed', taskId: 'task-1', response: `住宿上限为500元。[${sourceRef}]`,
        artifacts: [], toolCalls: ['mcp__knowledge__search_knowledge'], sourceRefs: [search.sourceRef, sourceRef], sessionId: 's' }
    }, onProgress: (event) => events.push(event.type) })
  assert.equal(result.status, 'ready')
  assert.deepEqual(events, [])
})

test('DSH 未用知识工具、出现非白名单来源或撤权时拒绝展示', async () => {
  const base = { task, context, knowledge: { search: async () => search, authorizeCitation: async () => true },
    generationPolicy: { allow: async () => true } }
  const completed = { type: 'completed' as const, taskId: 'task-1', response: `住宿上限为500元。[${sourceRef}]`,
    artifacts: [], toolCalls: ['mcp__knowledge__search_knowledge'], sourceRefs: [sourceRef], sessionId: 's' }
  assert.equal((await executeVerifiedKnowledgeTask({ ...base, runModel: async () =>
    ({ ...completed, toolCalls: [] }) })).status, 'rejected')
  assert.equal((await executeVerifiedKnowledgeTask({ ...base, runModel: async () =>
    ({ ...completed, sourceRefs: ['knowledge:other'] }) })).status, 'rejected')
  assert.equal((await executeVerifiedKnowledgeTask({ ...base,
    knowledge: { ...base.knowledge, authorizeCitation: async () => false },
    runModel: async () => completed })).status, 'rejected')
})
