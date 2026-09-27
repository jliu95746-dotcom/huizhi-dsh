import type { TaskRequest } from '../contracts.js'
import { runTask, type RunTaskOptions, type TaskEvent } from '../runner.js'
import { KnowledgeError, type UntrustedKnowledgeContext } from './foundation.js'
import { buildKnowledgePrompt, validateKnowledgeAnswer } from './answer.js'
import type { KnowledgeSearchResult } from './query.js'

type CompletedTask = TaskEvent & { type: 'completed' }
export interface KnowledgeTaskDependencies {
  task: TaskRequest
  context: UntrustedKnowledgeContext
  knowledgeBaseId?: string
  deliveryRecorder?: { recordDelivery(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; traceId: string; question: string; status: 'ready' | 'rejected';
    sourceRefs: string[]; searchVersion: string }): Promise<{ receiptId: string }> }
  knowledge: {
    search(context: UntrustedKnowledgeContext, query: string): Promise<KnowledgeSearchResult>
    authorizeCitation(context: UntrustedKnowledgeContext, hit: KnowledgeSearchResult['hits'][number]): Promise<boolean>
  }
  generationPolicy: { allow(context: UntrustedKnowledgeContext, search: KnowledgeSearchResult): Promise<boolean> }
  runModel?: (task: TaskRequest, options: RunTaskOptions) => Promise<CompletedTask>
  onProgress?: (event: Exclude<TaskEvent, CompletedTask>) => void
  options?: Omit<RunTaskOptions, 'onEvent'>
}
export interface KnowledgeTaskDelivery {
  status: 'ready' | 'rejected'
  answer: string
  reason: string
  sourceRefs: string[]
  searchVersion: string
}

export async function executeVerifiedKnowledgeTask(input: KnowledgeTaskDependencies): Promise<KnowledgeTaskDelivery> {
  const { task, context } = input
  if (!context.serviceCredential || task.taskId !== context.taskId ||
      task.organizationId !== context.organizationId || task.requesterId !== context.requesterId ||
      task.capabilities.length !== 1 || task.capabilities[0] !== 'knowledge') {
    throw new KnowledgeError('IDENTITY_MISMATCH', '知识问答任务与可信身份不一致')
  }
  const search = await input.knowledge.search(context, task.prompt)
  const reject = (reason: string, answer = '证据校验未通过，当前无法给出确定答案。'): KnowledgeTaskDelivery =>
    ({ status: 'rejected', answer, reason, sourceRefs: [], searchVersion: search.version })
  const finish = async (delivery: KnowledgeTaskDelivery): Promise<KnowledgeTaskDelivery> => {
    if (input.deliveryRecorder) {
      if (!input.knowledgeBaseId || search.hits.some((hit) => hit.knowledgeBaseId !== input.knowledgeBaseId)) {
        throw new KnowledgeError('INVALID_INPUT', '反馈交付必须绑定单个可信知识库')
      }
      await input.deliveryRecorder.recordDelivery(context, { knowledgeBaseId: input.knowledgeBaseId,
        traceId: task.taskId, question: task.prompt, status: delivery.status,
        sourceRefs: delivery.sourceRefs, searchVersion: delivery.searchVersion })
    }
    return delivery
  }
  if (search.status !== 'ok') return finish(reject(search.status, search.message))
  if (!search.hits.length || !await input.generationPolicy.allow(context, search)) return finish(reject('MODEL_DATA_BLOCKED',
    '当前资料不允许发送给生成模型，无法给出确定答案。')
  )
  const prompt = buildKnowledgePrompt(task.prompt, search)
  const completed = await (input.runModel ?? runTask)({ ...task, prompt }, {
    ...input.options,
    onEvent: (event) => {
      if (event.type !== 'completed') input.onProgress?.(event)
    },
  })
  if (!completed.toolCalls.includes('mcp__knowledge__search_knowledge')) return finish(reject('KNOWLEDGE_TOOL_NOT_CALLED'))
  const allowlist = new Set([search.sourceRef, ...search.hits.map((hit) => hit.sourceRef)])
  if (!completed.sourceRefs.some((ref) => ref !== search.sourceRef && allowlist.has(ref)) ||
      completed.sourceRefs.some((ref) => !allowlist.has(ref))) return finish(reject('TOOL_SOURCE_NOT_ALLOWED'))
  const check = await validateKnowledgeAnswer(context, search, completed.response, input.knowledge)
  if (!check.ok) return finish(reject(check.reason))
  return finish({ status: 'ready', answer: completed.response, reason: 'VERIFIED',
    sourceRefs: [...new Set([...completed.response.matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1]))],
    searchVersion: search.version })
}
