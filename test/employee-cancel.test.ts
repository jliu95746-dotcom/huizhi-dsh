import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cancelEmployeeTasks } from '../src/employee-cancel.js'
import { parsePluginConfig, parseTaskRequest } from '../src/contracts.js'
import { submittedTaskIdsFromNotification } from '../src/runner.js'

test('提交结果提取外部任务编号，取消时必须取得外部确认', async () => {
  const notification = {
    method: 'session.event',
    params: { event: { type: 'tool/result', data: { message: { content: [{
      toolCallId: 'call-1', content: [{ type: 'text', text: '{"externalTaskId":"demo-001","status":"pending"}' }],
    }] } } } },
  }
  assert.deepEqual(submittedTaskIdsFromNotification(notification), ['demo-001'])
  const mockPath = fileURLToPath(new URL('./mock-business-mcp.js', import.meta.url))
  const plugins = parsePluginConfig({
    version: 1,
    capabilities: {
      files: { enabled: false }, knowledge: { enabled: false },
      employeeTasks: { enabled: true, transport: 'stdio', command: process.execPath, args: [mockPath, 'employeeTasks'] },
      bi: { enabled: false }, reports: { enabled: false },
    },
  })
  const task = parseTaskRequest({
    version: 1, taskId: 'cancel-test', organizationId: 'demo-org', requesterId: 'demo-user',
    prompt: '取消外部任务', capabilities: ['employeeTasks'],
  })
  const result = await cancelEmployeeTasks(task, plugins, ['demo-001'])
  assert.deepEqual(result, [{ externalTaskId: 'demo-001', status: 'cancelled' }])
})
