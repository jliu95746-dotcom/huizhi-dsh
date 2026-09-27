import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CONTRACT_VERSION } from '../plugin-contract.js'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type UntrustedKnowledgeContext } from './foundation.js'
import type { KnowledgeSearchResult } from './query.js'

export interface KnowledgeMcpDependencies {
  identity: KnowledgeIdentityVerifier
  context: UntrustedKnowledgeContext
  search(context: UntrustedKnowledgeContext, query: string): Promise<KnowledgeSearchResult>
}

const tools = [
  { name: 'describe_capability', description: '返回知识库插件能力和契约版本',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object', properties: { contractVersion: { type: 'integer' }, capability: { type: 'string' } },
      required: ['contractVersion', 'capability'], additionalProperties: false } },
  { name: 'search_knowledge', description: '检索当前身份可读取的知识证据；资料不足时返回明确状态',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } },
      required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      hits: { type: 'array' }, sourceRef: { type: 'string' }, version: { type: 'string' },
      schemaVersion: { type: 'integer' }, status: { type: 'string' }, traceId: { type: 'string' },
      message: { type: 'string' },
    }, required: ['hits', 'sourceRef', 'version', 'schemaVersion', 'status', 'traceId', 'message'],
    additionalProperties: false } },
] as const

export function createKnowledgeMcpServer(dependencies: KnowledgeMcpDependencies): Server {
  const server = new Server({ name: 'huizhi-knowledge', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    try {
      await verifyKnowledgeActor(dependencies.context, dependencies.identity)
      if (name === 'describe_capability') {
        const value = { contractVersion: CONTRACT_VERSION, capability: 'knowledge' }
        return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
      }
      if (name !== 'search_knowledge') throw new KnowledgeError('UNKNOWN_TOOL', '未知知识库工具')
      if (dependencies.context.requesterId === 'diagnostic') {
        throw new KnowledgeError('ACCESS_DENIED', '诊断身份不能检索业务知识')
      }
      const args = request.params.arguments
      const query = args?.query
      if (typeof query !== 'string' || !query.trim() || query.length > 2000 || Object.keys(args ?? {}).some((key) => key !== 'query')) {
        throw new KnowledgeError('INVALID_INPUT', 'query 必须是非空字符串且不能超过 2000 字')
      }
      const { diagnostics: _internalDiagnostics, ...value } = await dependencies.search(dependencies.context, query)
      return { structuredContent: value as unknown as Record<string, unknown>,
        content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : 'SEARCH_UNAVAILABLE'
      const message = error instanceof KnowledgeError ? error.message : '知识检索服务暂时不可用'
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code, message }) }] }
    }
  })
  return server
}

export function readStdioKnowledgeContext(environment: NodeJS.ProcessEnv): UntrustedKnowledgeContext {
  const encoded = environment.HUIZHI_TASK_CONTEXT_B64
  const serviceCredential = environment.HUIZHI_KNOWLEDGE_SERVICE_CREDENTIAL
  if (!encoded || !serviceCredential) throw new KnowledgeError('UNAUTHENTICATED', '知识插件缺少任务上下文或服务身份')
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown> }
  catch { throw new KnowledgeError('UNAUTHENTICATED', '任务上下文无效') }
  if (typeof parsed.organizationId !== 'string' || !parsed.organizationId ||
      typeof parsed.requesterId !== 'string' || !parsed.requesterId ||
      typeof parsed.taskId !== 'string' || !parsed.taskId) {
    throw new KnowledgeError('UNAUTHENTICATED', '任务身份字段不完整')
  }
  return { serviceCredential, organizationId: parsed.organizationId, requesterId: parsed.requesterId,
    taskId: parsed.taskId, ...(typeof parsed.authorizationRef === 'string' ? { authorizationRef: parsed.authorizationRef } : {}) }
}

export async function serveKnowledgeStdio(dependencies: Omit<KnowledgeMcpDependencies, 'context'>,
  environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const context = readStdioKnowledgeContext(environment)
  const server = createKnowledgeMcpServer({ ...dependencies, context })
  await server.connect(new StdioServerTransport())
}
