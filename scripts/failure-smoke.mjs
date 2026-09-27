import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runTask } from '../dist/src/runner.js'
import { projectRoot, setupRuntime } from '../dist/src/runtime.js'

const home = await mkdtemp(join(homedir(), '.dsh-huizhi-failure-'))
if (dirname(home) !== homedir() || !basename(home).startsWith('.dsh-huizhi-failure-')) throw new Error('测试目录越界')
const mock = join(projectRoot, 'dist', 'test', 'mock-business-mcp.js')
const config = (command) => ({
  version: 1,
  capabilities: {
    files: { enabled: true, transport: 'stdio', command, args: [mock, 'files'] },
    knowledge: { enabled: false }, employeeTasks: { enabled: false }, bi: { enabled: false }, reports: { enabled: false },
  },
})
const task = {
  version: 1, taskId: 'failure-001', organizationId: 'demo-org', requesterId: 'demo-user',
  capabilities: ['files'], prompt: '请务必调用 files.read_document，path="not-authorized.txt"。如果工具返回错误，请说明无法读取，不要编造内容。',
}
try {
  await setupRuntime(home)
  await writeFile(join(home, 'plugins.json'), JSON.stringify(config(process.execPath)), { mode: 0o600 })
  const events = []
  await assert.rejects(runTask(task, { home, timeoutMs: 180000, onEvent: (event) => events.push(event) }), /工具调用失败/)
  assert.ok(events.some((event) => event.type === 'tool_finished' && event.toolName === 'mcp__files__read_document' && !event.success))
  assert.equal(events.at(-1)?.type, 'failed')

  await writeFile(join(home, 'plugins.json'), JSON.stringify(config('/definitely/missing/huizhi-plugin')), { mode: 0o600 })
  const missingEvents = []
  await assert.rejects(runTask(task, { home, timeoutMs: 10000, onEvent: (event) => missingEvents.push(event) }))
  assert.equal(missingEvents.at(-1)?.type, 'failed')
  assert.ok(!missingEvents.some((event) => event.type === 'ready'))

  const slowConfig = config(process.execPath)
  slowConfig.capabilities.files.toolCallTimeoutMs = 100
  await writeFile(join(home, 'plugins.json'), JSON.stringify(slowConfig), { mode: 0o600 })
  const slowEvents = []
  await assert.rejects(runTask({
    ...task, taskId: 'failure-timeout-002',
    prompt: '请务必调用 files.read_document，path="slow.txt"。如果工具超时，请说明未读到文件，不要编造内容。',
  }, { home, timeoutMs: 180000, onEvent: (event) => slowEvents.push(event) }), /工具调用失败/)
  assert.ok(slowEvents.some((event) => event.type === 'tool_finished' && event.toolName === 'mcp__files__read_document' && !event.success))
  assert.equal(slowEvents.at(-1)?.type, 'failed')

  const crashConfig = config(process.execPath)
  crashConfig.capabilities.files.toolCallTimeoutMs = 1_000
  await writeFile(join(home, 'plugins.json'), JSON.stringify(crashConfig), { mode: 0o600 })
  const crashEvents = []
  await assert.rejects(runTask({
    ...task, taskId: 'failure-crash-003',
    prompt: '请务必调用 files.read_document，path="crash.txt"。若插件进程中断，请明确说明失败。',
  }, { home, timeoutMs: 90_000, onEvent: (event) => crashEvents.push(event) }))
  assert.equal(crashEvents.at(-1)?.type, 'failed')
  assert.ok(!crashEvents.some((event) => event.type === 'completed'))
  process.stdout.write(`${JSON.stringify({ status: 'passed', toolErrorFailed: true, missingPluginFailedBeforeModel: true, toolTimeoutFailed: true, pluginCrashFailed: true })}\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}
