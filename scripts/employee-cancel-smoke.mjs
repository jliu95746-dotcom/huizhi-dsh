import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runTask } from '../dist/src/runner.js'
import { projectRoot, setupRuntime } from '../dist/src/runtime.js'

const home = await mkdtemp(join(homedir(), '.dsh-huizhi-employee-cancel-'))
if (dirname(home) !== homedir() || !basename(home).startsWith('.dsh-huizhi-employee-cancel-')) throw new Error('测试目录越界')
const controller = new AbortController()
const events = []
try {
  await setupRuntime(home)
  await writeFile(join(home, 'plugins.json'), JSON.stringify({
    version: 1,
    capabilities: {
      files: { enabled: false }, knowledge: { enabled: false },
      employeeTasks: {
        enabled: true, transport: 'stdio', command: process.execPath,
        args: [join(projectRoot, 'dist', 'test', 'mock-business-mcp.js'), 'employeeTasks'],
      },
      bi: { enabled: false }, reports: { enabled: false },
    },
  }), { mode: 0o600 })
  await assert.rejects(runTask({
    version: 1, taskId: 'employee-cancel-001', organizationId: 'demo-org', requesterId: 'demo-user',
    capabilities: ['employeeTasks'],
    prompt: '请务必调用 employeeTasks.submit_task，title="审核 4 条常见问题"，idempotencyKey="employee-cancel-001"，并读取工具结果。',
  }, {
    home, signal: controller.signal, timeoutMs: 180_000,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'tool_finished' && event.toolName === 'mcp__employeeTasks__submit_task') controller.abort()
    },
  }), /任务已取消/)
  const cancellation = events.at(-1)
  assert.equal(cancellation?.type, 'cancelled')
  assert.equal(cancellation.externalStatus, 'cancelled')
  assert.deepEqual(cancellation.externalTasks, [{ externalTaskId: 'demo-001', status: 'cancelled' }])
  process.stdout.write(`${JSON.stringify({ status: 'passed', externalStatus: cancellation.externalStatus, externalTasks: cancellation.externalTasks })}\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}
