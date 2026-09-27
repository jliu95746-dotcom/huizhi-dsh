import { serveKnowledgeStdio } from '../src/knowledge/mcp.js'

await serveKnowledgeStdio({
  identity: { verify: async (context) => {
    if (context.serviceCredential !== 'synthetic-check-only') throw new Error('服务身份无效')
    return { tenantId: 7, organizationId: context.organizationId, requesterId: context.requesterId,
      principals: [{ type: 'user', id: context.requesterId }], permissions: [] }
  } },
  search: async () => { throw new Error('诊断身份不应检索') },
})
