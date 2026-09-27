import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { checkOnePlugin } from '../src/check-plugins.js'
import type { PluginConfig } from '../src/contracts.js'

test('现有 plugins check 能通过独立 knowledge stdio 服务的契约检查', async () => {
  const variable = 'HUIZHI_P3_SYNTHETIC_CHECK_CREDENTIAL'
  process.env[variable] = 'synthetic-check-only'
  const config: PluginConfig = { version: 1, capabilities: {
    files: { enabled: false }, employeeTasks: { enabled: false }, bi: { enabled: false }, reports: { enabled: false },
    knowledge: { enabled: true, transport: 'stdio', command: process.execPath,
      args: [resolve('dist/test/knowledge-p3-mcp-fixture.js')],
      envFrom: { HUIZHI_KNOWLEDGE_SERVICE_CREDENTIAL: variable } },
  } }
  try {
    const result = await checkOnePlugin('knowledge', config)
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.tools, ['describe_capability', 'search_knowledge'])
  } finally { delete process.env[variable] }
})
