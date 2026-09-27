import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildTaskPluginPatch, type PluginConfig, type TaskRequest } from './contracts.js'
import { childEnvironment, projectRoot } from './runtime.js'

export interface ExternalTaskCancellation { externalTaskId: string; status: 'cancelled' | 'pending_confirmation' }

function contentObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`外部取消操作超时 ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function cancelEmployeeTasks(
  task: TaskRequest,
  plugins: PluginConfig,
  externalTaskIds: readonly string[],
): Promise<ExternalTaskCancellation[]> {
  if (externalTaskIds.length === 0) return []
  const scopedTask = { ...task, capabilities: ['employeeTasks'] as const } as TaskRequest
  const config = buildTaskPluginPatch(scopedTask, plugins, join(projectRoot, 'dist', 'src', 'report-mcp.js'), '/unused')[0].insert[0].config
  const controller = new AbortController()
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({
      command: config.command!, args: config.args,
      env: Object.fromEntries(Object.entries({ ...childEnvironment(), ...config.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      stderr: 'pipe',
    })
    : new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: { headers: config.headers, signal: controller.signal },
    })
  const client = new Client({ name: 'huizhi-external-cancel', version: '0.1.0' })
  const results: ExternalTaskCancellation[] = []
  try {
    await withTimeout(client.connect(transport), 15_000)
    for (const externalTaskId of externalTaskIds.slice(0, 20)) {
      try {
        const response = await client.callTool({ name: 'cancel_task', arguments: { externalTaskId } }, undefined, { timeout: 15_000 })
        const content = Array.isArray(response.content) ? response.content : []
        const firstText = content.find((block: unknown) => contentObject(block)?.type === 'text') as { text?: unknown } | undefined
        const parsed = contentObject(response.structuredContent) ??
          (typeof firstText?.text === 'string' ? contentObject(JSON.parse(firstText.text)) : undefined)
        results.push({ externalTaskId, status: !response.isError && parsed?.status === 'cancelled' ? 'cancelled' : 'pending_confirmation' })
      } catch {
        results.push({ externalTaskId, status: 'pending_confirmation' })
      }
    }
  } catch {
    return externalTaskIds.slice(0, 20).map((externalTaskId) => ({ externalTaskId, status: 'pending_confirmation' }))
  } finally {
    controller.abort()
    try { await withTimeout(client.close(), 5_000) } catch { /* preserve pending confirmation */ }
  }
  return results
}
