import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createKnowledgeMcpServer } from '../src/knowledge/mcp.js'
import { validateExternalToolContract } from '../src/plugin-contract.js'
import type { KnowledgeSearchResult } from '../src/knowledge/query.js'

const empty: KnowledgeSearchResult = { schemaVersion: 1, sourceRef: 'knowledge-query:abc', version: 'snapshot-1',
  status: 'no_evidence', traceId: 'task-1', hits: [], message: '当前资料不足，无法给出确定答案。',
  diagnostics: { recalled: { keyword: 0, vector: 0, exactNumber: 0 }, authorized: 0, filtered: 0,
    rerankStatus: 'skipped', lowRelevance: 0 } }

test('正式 knowledge MCP 只声明两个工具并符合 v1 契约；诊断身份不能搜索', async () => {
  let searches = 0
  const server = createKnowledgeMcpServer({
    identity: { verify: async (context) => ({ tenantId: 7, organizationId: context.organizationId,
      requesterId: context.requesterId, principals: [{ type: 'user', id: context.requesterId }], permissions: [] }) },
    context: { serviceCredential: 'trusted', organizationId: 'diagnostic', requesterId: 'diagnostic' },
    search: async () => { searches++; return empty },
  })
  const client = new Client({ name: 'test', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const listed = await client.listTools()
    const manifest = await client.callTool({ name: 'describe_capability', arguments: {} })
    assert.deepEqual(validateExternalToolContract('knowledge', listed.tools, manifest.structuredContent,
      client.getServerVersion()?.version), [])
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['describe_capability', 'search_knowledge'])
    const denied = await client.callTool({ name: 'search_knowledge', arguments: { query: '合同金额' } })
    assert.equal(denied.isError, true)
    assert.equal(searches, 0)
  } finally { await client.close(); await server.close() }
})

test('授权身份搜索返回证据扩展并保持必填字段', async () => {
  const server = createKnowledgeMcpServer({
    identity: { verify: async (context) => ({ tenantId: 7, organizationId: context.organizationId,
      requesterId: context.requesterId, principals: [{ type: 'user', id: context.requesterId }], permissions: [] }) },
    context: { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'alice' },
    search: async (_context, query) => { assert.equal(query, '差旅规则'); return empty },
  })
  const client = new Client({ name: 'test', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: 'search_knowledge', arguments: { query: '差旅规则' } })
    assert.equal(result.isError, undefined)
    assert.equal((result.structuredContent as unknown as KnowledgeSearchResult).status, 'no_evidence')
    assert.equal((result.structuredContent as unknown as KnowledgeSearchResult).version, 'snapshot-1')
    assert.equal('diagnostics' in (result.structuredContent as object), false)
  } finally { await client.close(); await server.close() }
})
