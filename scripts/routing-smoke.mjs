import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createCommandDispatcher } from '../dist/src/command-dispatcher.js'
import { createOperationCatalog } from '../dist/src/operation-catalog.js'
import { runTask } from '../dist/src/runner.js'
import { setupRuntime } from '../dist/src/runtime.js'

const home = await mkdtemp(join(homedir(), '.dsh-huizhi-routing-smoke-'))
if (dirname(home) !== homedir() || !basename(home).startsWith('.dsh-huizhi-routing-smoke-')) throw new Error('测试目录越界')
try {
  await setupRuntime(home)
  let modelTasks = 0
  const dispatcher = createCommandDispatcher({
    stateDirectory: join(home, 'requests'), dshHome: home,
    catalog: createOperationCatalog([{ id: 'employee.profile.update', description: '模拟保存', executor: 'business', effect: 'write' }]),
    authorize: async () => ({ allowed: true, capabilities: ['reports'] }),
    businessHandlers: { 'employee.profile.update': async () => ({ mockSaved: true }) },
    runDsh: async (task, options) => { modelTasks++; return runTask(task, options) },
  })
  const context = { source: 'desktop', organizationId: 'demo-org', requesterId: 'demo-user' }
  const ordinary = { version: 1, kind: 'action', operationId: 'employee.profile.update', parameters: {} }
  assert.equal((await dispatcher.dispatchCommand({ ...ordinary, requestId: 'desktop-save' }, context)).route, 'desktop_direct')
  assert.equal((await dispatcher.dispatchCommand({ ...ordinary, requestId: 'mobile-save' }, { ...context, source: 'mobile' })).route, 'enterprise_direct')
  assert.equal(modelTasks, 0)
  const report = JSON.parse(await readFile(new URL('../examples/command-report.json', import.meta.url), 'utf8'))
  const created = await dispatcher.dispatchCommand(report, context, { timeoutMs: 180000 })
  assert.equal(created.route, 'enterprise_dsh')
  assert.ok(created.value.toolCalls.includes('mcp__reports__create_weekly_report'))
  assert.ok(created.value.artifacts.length > 0)
  assert.match(await readFile(created.value.artifacts[0], 'utf8'), /本周完成/)
  assert.equal((await dispatcher.dispatchCommand(report, context)).replayed, true)
  assert.equal(modelTasks, 1)
  const mobile = await dispatcher.dispatchCommand({ version: 1, requestId: 'mobile-instruction', kind: 'instruction', prompt: '只回答：已连接。' }, { ...context, source: 'mobile' }, { timeoutMs: 180000 })
  assert.equal(mobile.route, 'enterprise_dsh')
  assert.match(mobile.value.response, /已连接/)
  assert.equal(modelTasks, 2)
  process.stdout.write(`${JSON.stringify({ status: 'passed', ordinaryOperationsModelTasks: 0, pluginThroughDsh: true, replayAvoidedModelTask: true, mobileInstructionThroughDsh: true })}\n`)
} finally { await rm(home, { recursive: true, force: true }) }
