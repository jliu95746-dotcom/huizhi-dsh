import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createCommandDispatcher, type DispatcherDependencies } from '../src/command-dispatcher.js'
import { createOperationCatalog } from '../src/operation-catalog.js'
import type { Command, TrustedContext } from '../src/command-contracts.js'
import { parsePluginConfig } from '../src/contracts.js'

const context: TrustedContext = { source: 'desktop', organizationId: 'org-1', requesterId: 'user-1', authorizationRef: 'grant-1' }
const action = (requestId: string, operationId = 'employee.profile.update'): Command => ({
  version: 1, requestId, kind: 'action', operationId, parameters: { employeeId: 'employee-1', name: '示例员工' },
})
const plugins = parsePluginConfig({ version: 1, capabilities: {
  files: { enabled: false }, knowledge: { enabled: false }, employeeTasks: { enabled: false },
  bi: { enabled: false }, reports: { enabled: true },
} })

async function fixture(t: TestContext, overrides: Partial<DispatcherDependencies> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'huizhi-routing-test-'))
  t.after(() => rm(stateDirectory, { recursive: true, force: true }))
  const seen = { business: 0, dsh: 0, auth: 0 }
  const dependencies: DispatcherDependencies = {
    stateDirectory,
    catalog: createOperationCatalog([{ id: 'employee.profile.update', executor: 'business', description: '修改员工资料', effect: 'write' }]),
    authorize: async () => { seen.auth++; return { allowed: true, capabilities: ['reports'] } },
    businessHandlers: {
      'employee.profile.update': async (input) => {
        seen.business++
        assert.deepEqual(input.context, context)
        assert.match(input.idempotencyKey, /^hz-[a-f0-9]{64}$/)
        return { saved: true }
      },
    },
    readPlugins: async () => plugins,
    runDsh: async (task) => {
      seen.dsh++
      return { type: 'completed', taskId: task.taskId, response: '示例结果', artifacts: [],
        toolCalls: ['mcp__reports__create_weekly_report'], sourceRefs: [], sessionId: 'session-1' }
    },
    ...overrides,
  }
  return { dependencies, seen, dispatcher: createCommandDispatcher(dependencies) }
}

test('电脑普通操作直接执行；手机普通操作进入企业入口但不启动模型', async (t) => {
  const contexts: TrustedContext[] = []
  const { dispatcher, seen } = await fixture(t, { businessHandlers: {
    'employee.profile.update': async (input) => { contexts.push(input.context); return { saved: true } },
  } })
  const events: string[] = []
  const desktop = await dispatcher.dispatchCommand(action('desktop-1'), context, { onEvent: (event) => events.push(event.type) })
  assert.equal(desktop.route, 'desktop_direct')
  assert.ok(!events.includes('enterprise_entered'))
  events.length = 0
  const mobileContext = { ...context, source: 'mobile' as const }
  const mobile = await dispatcher.dispatchCommand(action('mobile-1'), mobileContext, { onEvent: (event) => events.push(event.type) })
  assert.equal(mobile.route, 'enterprise_direct')
  assert.ok(events.includes('enterprise_entered'))
  assert.deepEqual(contexts, [context, mobileContext])
  assert.equal(seen.dsh, 0)
})

test('DSH 插件优先于电脑或手机来源；手机自然语言也进入 DSH', async (t) => {
  const { dispatcher, seen } = await fixture(t)
  for (const source of ['desktop', 'mobile'] as const) {
    const result = await dispatcher.dispatchCommand(action(`report-${source}`, 'reports.create_weekly_report'), { ...context, source })
    assert.equal(result.route, 'enterprise_dsh')
  }
  const result = await dispatcher.dispatchCommand({ version: 1, requestId: 'mobile-prompt', kind: 'instruction', prompt: '你好' }, { ...context, source: 'mobile' })
  assert.equal(result.route, 'enterprise_dsh')
  assert.equal(seen.dsh, 3)
  assert.equal(seen.business, 0)
})

test('业务别名仍强制绑定 DSH 插件；没有插件授权不能执行', async (t) => {
  const catalog = createOperationCatalog([
    { id: 'weekly.generate', executor: 'dsh', effect: 'write', description: '生成周报', capability: 'reports', tool: 'create_weekly_report' },
  ])
  const { dispatcher, dependencies, seen } = await fixture(t, { catalog, businessHandlers: {} })
  assert.equal((await dispatcher.dispatchCommand(action('alias-1', 'weekly.generate'), context)).route, 'enterprise_dsh')
  const denied = createCommandDispatcher({ ...dependencies, authorize: async () => ({ allowed: true, capabilities: [] }) })
  await assert.rejects(denied.dispatchCommand(action('alias-2', 'weekly.generate'), context), { code: 'FORBIDDEN' })
  assert.equal(seen.dsh, 1)
})

test('电脑其他 Agent 的复合任务按步骤重新分流和鉴权', async (t) => {
  const { dispatcher, seen } = await fixture(t, {
    desktopAgent: async ({ executeAction }) => {
      const saved = await executeAction('save', 'employee.profile.update', { name: '示例员工' })
      const report = await executeAction('report', 'reports.create_weekly_report', { period: '本周' })
      return { routes: [saved.route, report.route] }
    },
  })
  const result = await dispatcher.dispatchCommand({ version: 1, requestId: 'desktop-prompt', kind: 'instruction', prompt: '保存资料后生成周报' }, context)
  assert.equal(result.route, 'desktop_agent')
  assert.deepEqual(result.value, { routes: ['desktop_direct', 'enterprise_dsh'] })
  assert.equal(seen.business, 1)
  assert.equal(seen.dsh, 1)
  assert.equal(seen.auth, 3)
})

test('重复请求跨入口实例返回持久化结果且仍然重新鉴权', async (t) => {
  const { dispatcher, dependencies, seen } = await fixture(t)
  const first = await dispatcher.dispatchCommand(action('repeat-1'), context)
  const restarted = createCommandDispatcher(dependencies)
  const repeated = await restarted.dispatchCommand(action('repeat-1'), context)
  assert.equal(first.replayed, false)
  assert.equal(repeated.replayed, true)
  assert.equal(seen.business, 1)
  assert.equal(seen.auth, 2)
  const denied = createCommandDispatcher({ ...dependencies, authorize: async () => ({ allowed: false }) })
  await assert.rejects(denied.dispatchCommand(action('repeat-1'), context), { code: 'FORBIDDEN' })
})

test('同一请求编号更换参数或设备来源被拒绝', async (t) => {
  const { dispatcher, seen } = await fixture(t)
  await dispatcher.dispatchCommand(action('conflict-1'), context)
  await assert.rejects(dispatcher.dispatchCommand({ ...action('conflict-1'), parameters: { name: '另一个人' } }, context), { code: 'REQUEST_CONFLICT' })
  await assert.rejects(dispatcher.dispatchCommand(action('conflict-1'), { ...context, source: 'mobile' }), { code: 'REQUEST_CONFLICT' })
  assert.equal(seen.business, 1)
})

test('并发重复提交只执行一次', async (t) => {
  let release!: () => void
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const { dispatcher } = await fixture(t, { businessHandlers: { 'employee.profile.update': async () => {
    calls++; started(); await gate; return { saved: true }
  } } })
  const first = dispatcher.dispatchCommand(action('parallel-1'), context)
  await active
  try { await assert.rejects(dispatcher.dispatchCommand(action('parallel-1'), context), { code: 'REQUEST_IN_PROGRESS' }) }
  finally { release() }
  await first
  assert.equal(calls, 1)
})

test('插件禁用和模型失败不能回退到普通业务，也不自动重新执行失败请求', async (t) => {
  const disabled = await fixture(t, { readPlugins: async () => ({ ...plugins, capabilities: { ...plugins.capabilities, reports: { enabled: false } } }) })
  await assert.rejects(disabled.dispatcher.dispatchCommand(action('disabled', 'reports.create_weekly_report'), context), { code: 'PLUGIN_DISABLED' })
  assert.equal(disabled.seen.dsh, 0)
  assert.equal(disabled.seen.business, 0)
  let calls = 0
  const broken = await fixture(t, { runDsh: async () => { calls++; throw new Error('模拟 DSH 故障') } })
  await assert.rejects(broken.dispatcher.dispatchCommand(action('broken', 'reports.create_weekly_report'), context), { code: 'EXECUTION_FAILED' })
  await assert.rejects(createCommandDispatcher(broken.dependencies).dispatchCommand(action('broken', 'reports.create_weekly_report'), context), { code: 'EXECUTION_FAILED' })
  assert.equal(calls, 1)
  assert.equal(broken.seen.business, 0)
})

test('客户端不能指定来源、执行路径或插件权限；未知操作不能执行', async (t) => {
  const { dispatcher, seen } = await fixture(t)
  for (const extra of [{ source: 'desktop' }, { executor: 'business' }, { capabilities: ['reports'] }, { requesterId: 'admin' }]) {
    await assert.rejects(dispatcher.dispatchCommand({ ...action('injection'), ...extra }, context), { code: 'INVALID_COMMAND' })
  }
  await assert.rejects(dispatcher.dispatchCommand(action('unknown', 'unknown.operation'), context), { code: 'UNKNOWN_OPERATION' })
  await assert.rejects(dispatcher.dispatchEnterpriseCommand(action('wrong-entry'), context), { code: 'WRONG_ENTRY' })
  assert.equal(seen.business + seen.dsh, 0)
})

test('插件操作不能登记为直通业务；客户端参数不能覆盖真实身份', async (t) => {
  assert.throws(() => createOperationCatalog([{ id: 'reports.create_weekly_report', executor: 'business', description: '绕过', effect: 'write' }]))
  const { dispatcher, dependencies } = await fixture(t)
  assert.throws(() => createCommandDispatcher({ ...dependencies, businessHandlers: { 'reports.create_weekly_report': async () => null } }))
  await dispatcher.dispatchCommand({ ...action('context-1'), parameters: { organizationId: 'forged', requesterId: 'admin' } }, context)
})

test('模型没有调用所选插件不能作为操作成功返回', async (t) => {
  const { dispatcher } = await fixture(t, { runDsh: async (task) => ({ type: 'completed', taskId: task.taskId,
    response: '已经完成', artifacts: [], sourceRefs: [], toolCalls: [], sessionId: 'session-1' }) })
  await assert.rejects(dispatcher.dispatchCommand(action('missing-tool', 'reports.create_weekly_report'), context), { code: 'REQUIRED_TOOL_NOT_CALLED' })
})

test('日志回调异常不能把已保存的操作重新执行', async (t) => {
  const { dispatcher, seen } = await fixture(t)
  const result = await dispatcher.dispatchCommand(action('observer-1'), context, { onEvent: () => { throw new Error('显示层故障') } })
  assert.equal(result.replayed, false)
  assert.equal((await dispatcher.dispatchCommand(action('observer-1'), context)).replayed, true)
  assert.equal(seen.business, 1)
})

test('超时后的写操作不自动重跑，提前取消不调用业务', async (t) => {
  let calls = 0
  const { dispatcher } = await fixture(t, { businessHandlers: { 'employee.profile.update': async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 80)); return { saved: true }
  } } })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(dispatcher.dispatchCommand(action('aborted'), context, { signal: controller.signal }), { code: 'CANCELLED' })
  assert.equal(calls, 0)
  await assert.rejects(dispatcher.dispatchCommand(action('timeout'), context, { timeoutMs: 20 }), { code: 'TIMED_OUT' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(dispatcher.dispatchCommand(action('timeout'), context), { code: 'TIMED_OUT' })
  assert.equal(calls, 1)
})

test('业务写入后子进程崩溃，另一个进程实例不得重新提交', async (t) => {
  const { dependencies, dispatcher, seen } = await fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./dispatcher-crash-worker.js', import.meta.url)), dependencies.stateDirectory], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += String(data) })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  assert.equal(code, 17, stderr)
  await assert.rejects(dispatcher.dispatchCommand(action('crash-request'), context), { code: 'REQUEST_IN_PROGRESS', pendingConfirmation: true })
  assert.equal(seen.business, 0)
  assert.equal(await readFile(join(dependencies.stateDirectory, 'effect.txt'), 'utf8'), 'saved\n')
  const [recordDirectory] = (await readdir(dependencies.stateDirectory)).filter((name) => /^[a-f0-9]{64}$/.test(name))
  assert.equal((await stat(join(dependencies.stateDirectory, recordDirectory))).mode & 0o777, 0o700)
  assert.equal((await stat(join(dependencies.stateDirectory, recordDirectory, 'record.json'))).mode & 0o777, 0o600)
})

test('复合任务重放重新检查子步骤权限；不能用自然语言权限绕过插件权限', async (t) => {
  let denyAction = false
  const { dispatcher, seen } = await fixture(t, {
    authorize: async ({ command }) => ({ allowed: !denyAction || command.kind === 'instruction', capabilities: ['reports'] }),
    desktopAgent: async ({ executeAction }) => { await executeAction('report', 'reports.create_weekly_report', {}); return { report: '示例数据' } },
  })
  const request: Command = { version: 1, requestId: 'replay-parent', kind: 'instruction', prompt: '生成周报' }
  await dispatcher.dispatchCommand(request, context)
  denyAction = true
  await assert.rejects(dispatcher.dispatchCommand(request, context), { code: 'FORBIDDEN' })
  assert.equal(seen.dsh, 1)
})

test('Agent 吞掉子步骤错误也不能把复合任务标记成功', async (t) => {
  const { dispatcher } = await fixture(t, { desktopAgent: async ({ executeAction }) => {
    await executeAction('bad', 'unknown.operation', {}).catch(() => undefined)
    return '声称已经完成'
  } })
  await assert.rejects(dispatcher.dispatchCommand({ version: 1, requestId: 'agent-failure', kind: 'instruction', prompt: '执行任务' }, context), { code: 'UNKNOWN_OPERATION' })
})

test('自然语言缓存不能在插件授权范围缩小后返回', async (t) => {
  const { dispatcher, dependencies } = await fixture(t)
  const request: Command = { version: 1, requestId: 'grant-change', kind: 'instruction', prompt: '生成周报' }
  const mobile = { ...context, source: 'mobile' as const }
  await dispatcher.dispatchCommand(request, mobile)
  const restricted = createCommandDispatcher({ ...dependencies, authorize: async () => ({ allowed: true, capabilities: [] }) })
  await assert.rejects(restricted.dispatchCommand(request, mobile), { code: 'REQUEST_CONFLICT' })
})

test('统一入口等待遵守取消信号的 DSH 执行器完成清理', async (t) => {
  let cleaned = false
  const { dispatcher } = await fixture(t, { runDsh: async (_task, options) => {
    await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    cleaned = true
    throw new Error('已关闭 DSH')
  } })
  await assert.rejects(dispatcher.dispatchCommand(action('cancel-dsh', 'reports.create_weekly_report'), context, { timeoutMs: 60 }), { code: 'TIMED_OUT' })
  assert.equal(cleaned, true)
})

test('CLI dispatch 能从服务端适配模块接入，手机明确操作不需要模型凭据', async (t) => {
  const { dependencies } = await fixture(t)
  const file = (name: string) => fileURLToPath(new URL(`../../examples/${name}`, import.meta.url))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'dispatch',
    '--input', file('command-save.json'), '--context', file('context-mobile.json'), '--adapter', file('routing-demo-adapter.mjs')],
  { env: { ...process.env, HUIZHI_ROUTING_DEMO_STATE: dependencies.stateDirectory }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (data) => { stdout += String(data) })
  child.stderr.on('data', (data) => { stderr += String(data) })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  assert.equal(code, 0, stderr)
  const events = stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'enterprise_entered'))
  assert.ok(!events.some((event) => event.type === 'dsh_event'))
  assert.equal(events.at(-1).route, 'enterprise_direct')
  assert.equal(events.at(-1).value.demonstration, true)
})
