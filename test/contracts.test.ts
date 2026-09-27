import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTaskPluginPatch,
  parsePluginConfig,
  parseTaskRequest,
  resolveCapabilities,
} from '../src/contracts.js'

const pluginConfig = parsePluginConfig({
  version: 1,
  capabilities: {
    files: { enabled: true, transport: 'stdio', command: '/usr/bin/node', args: ['/srv/files.js'] },
    knowledge: { enabled: false },
    employeeTasks: { enabled: false },
    bi: { enabled: false },
    reports: { enabled: true },
  },
})

test('task validation keeps caller identity separate from model instructions', () => {
  const task = parseTaskRequest({
    version: 1,
    taskId: 'weekly-1',
    organizationId: 'acme',
    requesterId: 'boss',
    authorizationRef: 'grant-42',
    prompt: '汇总本周资料',
    capabilities: ['files', 'reports'],
  })
  assert.equal(task.requesterId, 'boss')
  assert.deepEqual(task.capabilities, ['files', 'reports'])
  assert.throws(() => parseTaskRequest({ ...task, requesterId: '' }), /requesterId/)
  assert.throws(() => parseTaskRequest({ ...task, taskId: 'bad\r\nX-Injected: 1' }), /taskId/)
  assert.throws(() => parseTaskRequest({ ...task, capabilities: ['files', 'files'] }), /重复/)
})

test('disabled capability fails before an agent is started', () => {
  const task = parseTaskRequest({
    version: 1,
    taskId: 'query-1',
    organizationId: 'acme',
    requesterId: 'boss',
    prompt: '查资料',
    capabilities: ['knowledge'],
  })
  assert.throws(() => resolveCapabilities(task, pluginConfig), /knowledge.*未启用/)
})

test('only selected configured servers enter the DSH patch', () => {
  const task = parseTaskRequest({
    version: 1,
    taskId: 'weekly-1',
    organizationId: 'acme',
    requesterId: 'boss',
    prompt: '写周报',
    capabilities: ['files', 'reports'],
  })
  const patch = buildTaskPluginPatch(task, pluginConfig, '/app/dist/src/report-mcp.js', '/private/reports')
  const names = patch[0].insert.map((entry) => entry.config.serverName)
  assert.deepEqual(names, ['files', 'reports'])
  assert.equal(patch[0].insert[0].config.transport, 'stdio')
  assert.equal(typeof patch[0].insert[0].config.env?.HUIZHI_TASK_CONTEXT_B64, 'string')
  assert.equal(patch[0].insert[1].config.env?.HUIZHI_OUTPUT_DIR, '/private/reports')
  assert.equal(patch[0].insert[0].config.toolCallTimeoutMs, 60_000)
})

test('可以单独设置插件调用超时', () => {
  const config = parsePluginConfig({
    version: 1,
    capabilities: {
      files: { enabled: true, transport: 'stdio', command: '/usr/bin/node', args: ['/srv/files.js'], toolCallTimeoutMs: 500 },
      knowledge: { enabled: false }, employeeTasks: { enabled: false }, bi: { enabled: false },
      reports: { enabled: true },
    },
  })
  const task = parseTaskRequest({
    version: 1, taskId: 'timeout-1', organizationId: 'org-1', requesterId: 'user-1',
    prompt: '读取文件', capabilities: ['files'],
  })
  assert.equal(buildTaskPluginPatch(task, config, '/app/report.js', '/private')[0].insert[0].config.toolCallTimeoutMs, 500)
})

test('misconfigured external server fails when enabled', () => {
  assert.throws(() => parsePluginConfig({
    version: 1,
    capabilities: {
      files: { enabled: true },
      knowledge: { enabled: false },
      employeeTasks: { enabled: false },
      bi: { enabled: false },
      reports: { enabled: true },
    },
  }), /files.*transport/)
})

test('HTTP MCP 配置从部署环境读取请求头，不把值写进插件配置', () => {
  const config = parsePluginConfig({
    version: 1,
    capabilities: {
      files: { enabled: false },
      knowledge: {
        enabled: true, transport: 'streamable-http', url: 'https://knowledge.example.internal/mcp',
        headersFrom: { Authorization: 'KNOWLEDGE_AUTH' },
      },
      employeeTasks: { enabled: false }, bi: { enabled: false }, reports: { enabled: true },
    },
  })
  const task = parseTaskRequest({
    version: 1, taskId: 'k-1', organizationId: 'org-1', requesterId: 'user-1',
    prompt: '查询服务流程', capabilities: ['knowledge'],
  })
  assert.throws(() => buildTaskPluginPatch(task, config, '/app/report.js', '/private', {}), /KNOWLEDGE_AUTH/)
  const patch = buildTaskPluginPatch(task, config, '/app/report.js', '/private', { KNOWLEDGE_AUTH: 'Bearer example' })
  assert.equal(patch[0].insert[0].config.transport, 'streamable-http')
  assert.equal(patch[0].insert[0].config.headers?.Authorization, 'Bearer example')
  assert.equal(patch[0].insert[0].config.headers?.['X-Huizhi-Organization-Id'], 'org-1')
})
