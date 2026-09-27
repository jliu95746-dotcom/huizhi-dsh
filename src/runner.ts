import { mkdtemp, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DeepSeekHarness, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { buildTaskPluginPatch, parseTaskRequest, resolveCapabilities, type TaskRequest } from './contracts.js'
import { checkOnePlugin } from './check-plugins.js'
import { cancelEmployeeTasks, type ExternalTaskCancellation } from './employee-cancel.js'
import { childEnvironment, profileName, projectRoot, readPluginConfig, runtimeHome, setupRuntime, writePrivateFile } from './runtime.js'

export type TaskEvent =
  | { type: 'started'; taskId: string }
  | { type: 'ready'; taskId: string }
  | { type: 'tool_started'; taskId: string; toolName: string; callId: string }
  | { type: 'tool_finished'; taskId: string; toolName: string; callId: string; success: boolean }
  | { type: 'notification'; method: string }
  | { type: 'completed'; taskId: string; response: string; artifacts: string[]; toolCalls: string[]; sourceRefs: string[]; sessionId: string }
  | { type: 'failed' | 'cancelled' | 'timed_out'; taskId: string; error: string;
      externalStatus?: 'cancelled' | 'pending_confirmation'; externalTasks?: ExternalTaskCancellation[] }

export interface RunTaskOptions {
  home?: string
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: TaskEvent) => void
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function toolEventFromNotification(
  notification: { method: string; params: Record<string, unknown> },
  taskId: string,
  knownNames: Map<string, string>,
): TaskEvent | undefined {
  if (notification.method !== 'session.event') return undefined
  const event = object(notification.params.event)
  const data = object(event?.data)
  if (event?.type === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
    knownNames.set(data.callId, data.name)
    return { type: 'tool_started', taskId, toolName: data.name, callId: data.callId }
  }
  if (event?.type === 'tool/result') {
    const content = object(data?.message)?.content
    const block = Array.isArray(content) ? object(content[0]) : undefined
    if (typeof block?.toolCallId === 'string') {
      return {
        type: 'tool_finished', taskId, toolName: knownNames.get(block.toolCallId) ?? 'unknown',
        callId: block.toolCallId, success: block.isError !== true,
      }
    }
  }
  return undefined
}

export function extractSourceRefs(events: RunResult['events']): string[] {
  const refs = new Set<string>()
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
  }
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || refs.size >= 100) return
    if (typeof value === 'string') {
      if (value.length < 100_000 && /^[\s]*[\[{]/.test(value)) {
        try { walk(JSON.parse(value), depth + 1) } catch { /* ordinary tool text */ }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const map = object(value)
    if (!map) return
    if (typeof map.sourceRef === 'string' && map.sourceRef.length <= 512) refs.add(map.sourceRef)
    if (Array.isArray(map.sourceRefs)) {
      for (const ref of map.sourceRefs) if (typeof ref === 'string' && ref.length <= 512) refs.add(ref)
    }
    for (const item of Object.values(map)) walk(item, depth + 1)
  }
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    for (const block of event.data.message.content) {
      if (!/^mcp__(files|knowledge|employeeTasks|bi)__/.test(toolNames.get(block.toolCallId) ?? '') || block.isError) continue
      walk(block.content, 0)
    }
  }
  return [...refs]
}

export function failedToolNames(events: RunResult['events']): string[] {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  const failures: string[] = []
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.message.content[0].isError === true) {
      failures.push(names.get(event.data.message.content[0].toolCallId) ?? 'unknown')
    }
  }
  return failures
}

export function submittedTaskIdsFromNotification(notification: { method: string; params: Record<string, unknown> }): string[] {
  if (notification.method !== 'session.event') return []
  const event = object(notification.params.event)
  if (event?.type !== 'tool/result') return []
  const message = object(object(event.data)?.message)
  const block = Array.isArray(message?.content) ? object(message.content[0]) : undefined
  if (block?.isError === true) return []
  const ids = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || ids.size >= 20) return
    if (typeof value === 'string') {
      if (value.length < 100_000 && /^[\s]*[\[{]/.test(value)) {
        try { walk(JSON.parse(value), depth + 1) } catch { /* ordinary tool text */ }
      }
      return
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    const map = object(value)
    if (!map) return
    if (typeof map.externalTaskId === 'string' && map.externalTaskId.length <= 128) ids.add(map.externalTaskId)
    for (const item of Object.values(map)) walk(item, depth + 1)
  }
  walk(block?.content, 0)
  return [...ids]
}

export async function runTask(raw: unknown, options: RunTaskOptions = {}): Promise<TaskEvent & { type: 'completed' }> {
  const task: TaskRequest = parseTaskRequest(raw)
  const timeoutMs = options.timeoutMs ?? 600_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error('timeoutMs 必须是 1 到 3600000 之间的整数')
  }
  const home = options.home || runtimeHome()
  await setupRuntime(home)
  const plugins = await readPluginConfig(home)
  resolveCapabilities(task, plugins)
  const taskDirectory = await mkdtemp(join(home, 'tasks', 'run-'))
  const ownerPath = join(taskDirectory, 'owner.json')
  await writePrivateFile(ownerPath, JSON.stringify({ pid: process.pid, taskId: task.taskId }))
  const outputDirectory = join(home, 'outputs', basename(taskDirectory))
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const patchPath = join(taskDirectory, 'plugins.patch.yml')
  const reportServer = join(projectRoot, 'dist', 'src', 'report-mcp.js')
  let harness: DeepSeekHarness | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let submitAttempted = false
  const submittedTaskIds = new Set<string>()
  try {
    const checkCancellation = () => { if (options.signal?.aborted) throw new Error('任务已取消') }
    checkCancellation()
    for (const capability of task.capabilities) {
      if (capability === 'reports') continue
      const checked = await checkOnePlugin(capability, plugins, task)
      checkCancellation()
      if (checked.issues.length) throw new Error(`${capability} 插件契约不合格：${checked.issues.join('；')}`)
    }
    const patch = buildTaskPluginPatch(task, plugins, reportServer, outputDirectory)
    await writePrivateFile(patchPath, JSON.stringify(patch))
    harness = new DeepSeekHarness({
      profile: profileName,
      patches: [patchPath],
      dshHome: home,
      processCwd: projectRoot,
      cwd: projectRoot,
      env: childEnvironment(),
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: Math.max(60_000, timeoutMs + 10_000),
    })
    const activeHarness = harness
    options.onEvent?.({ type: 'started', taskId: task.taskId })
    let rejectStop!: (reason: Error) => void
    let stopReason: Error | undefined
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
    const stop = (reason: Error) => { stopReason = reason; rejectStop(reason) }
    abortListener = () => stop(new Error('任务已取消'))
    if (options.signal?.aborted) abortListener()
    else options.signal?.addEventListener('abort', abortListener, { once: true })
    timer = setTimeout(() => stop(new Error('任务超时')), timeoutMs)
    const knownNames = new Map<string, string>()
    const running = (async () => {
      if (stopReason) throw stopReason
      await activeHarness.start()
      if (stopReason) throw stopReason
      options.onEvent?.({ type: 'ready', taskId: task.taskId })
      return activeHarness.run(task.prompt, {
        onNotification: (notification) => {
          const toolEvent = toolEventFromNotification(notification, task.taskId, knownNames)
          if (toolEvent?.type === 'tool_started' && toolEvent.toolName === 'mcp__employeeTasks__submit_task') {
            submitAttempted = true
          }
          if (toolEvent?.type === 'tool_finished' && toolEvent.toolName === 'mcp__employeeTasks__submit_task') {
            for (const id of submittedTaskIdsFromNotification(notification)) submittedTaskIds.add(id)
          }
          options.onEvent?.(toolEvent ?? { type: 'notification', method: notification.method })
        },
      })
    })()
    const result = await Promise.race([running, stopped])
    await activeHarness.close()
    const failedTools = failedToolNames(result.events)
    if (failedTools.length) throw new Error(`工具调用失败：${failedTools.join(', ')}`)
    if (!result.finalResponse.trim()) throw new Error('模型未返回最终答复')
    const artifacts = (await readdir(outputDirectory)).map((file) => join(outputDirectory, file))
    const toolCalls = result.events.filter((event) => event.type === 'tool/call').map((event) => event.data.name)
    const completed: TaskEvent & { type: 'completed' } = {
      type: 'completed', taskId: task.taskId, response: result.finalResponse, artifacts, toolCalls,
      sourceRefs: extractSourceRefs(result.events), sessionId: result.sessionId,
    }
    options.onEvent?.(completed)
    return completed
  } catch (error) {
    const message = (error as Error).message
    const type = message === '任务已取消' ? 'cancelled' : message === '任务超时' ? 'timed_out' : 'failed'
    let externalTasks: ExternalTaskCancellation[] = []
    if (submitAttempted && (type === 'cancelled' || type === 'timed_out')) {
      try { await harness?.close() } catch { /* still attempt external cancellation */ }
      try { externalTasks = await cancelEmployeeTasks(task, plugins, [...submittedTaskIds]) }
      catch { externalTasks = [...submittedTaskIds].map((externalTaskId) => ({ externalTaskId, status: 'pending_confirmation' })) }
    }
    const externalStatus = submitAttempted
      ? (externalTasks.length > 0 && externalTasks.every((item) => item.status === 'cancelled')
        ? 'cancelled' : 'pending_confirmation')
      : undefined
    options.onEvent?.({ type, taskId: task.taskId, error: message,
      ...(externalStatus ? { externalStatus, externalTasks } : {}) })
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    const cleanupErrors: unknown[] = []
    if (harness) {
      try { await harness.close() } catch (error) { cleanupErrors.push(error) }
    }
    try { await unlink(patchPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error)
    }
    try { await unlink(ownerPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error)
    }
    try { await rmdir(taskDirectory) } catch (error) { cleanupErrors.push(error) }
    try { await rmdir(outputDirectory) } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) cleanupErrors.push(error)
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '任务资源清理失败')
  }
}
