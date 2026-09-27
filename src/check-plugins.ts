import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildTaskPluginPatch, type Capability, type PluginConfig, type TaskRequest } from './contracts.js'
import { validateExternalToolContract } from './plugin-contract.js'
import { childEnvironment, projectRoot, readPluginConfig, runtimeHome } from './runtime.js'

type ExternalCapability = Exclude<Capability, 'reports'>
export interface PluginCheckResult { capability: ExternalCapability; serverVersion?: string; tools: string[]; issues: string[] }

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`插件验收超时 ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function checkOnePlugin(capability: ExternalCapability, plugins: PluginConfig, actualTask?: TaskRequest): Promise<PluginCheckResult> {
  const task: TaskRequest = actualTask
    ? { ...actualTask, capabilities: [capability] }
    : {
      version: 1, taskId: 'plugin-check', organizationId: 'diagnostic', requesterId: 'diagnostic',
      prompt: '只用于插件契约检查', capabilities: [capability],
    }
  const config = buildTaskPluginPatch(task, plugins, join(projectRoot, 'dist', 'src', 'report-mcp.js'), '/unused')[0].insert[0].config
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
  const client = new Client({ name: 'huizhi-plugin-check', version: '0.1.0' })
  try {
    await bounded(client.connect(transport), 15_000)
    const listed = await bounded(client.listTools(), 15_000)
    const toolNames = listed.tools.map((tool) => tool.name)
    const manifestResult = await bounded(client.callTool({ name: 'describe_capability', arguments: {} }), 15_000)
    if (manifestResult.isError) throw new Error('describe_capability 返回错误')
    const blocks = Array.isArray(manifestResult.content) ? manifestResult.content : []
    const firstText = blocks.find((block: unknown) =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') as { text?: unknown } | undefined
    const manifest: unknown = manifestResult.structuredContent ??
      (typeof firstText?.text === 'string' ? JSON.parse(firstText.text) : undefined)
    const serverVersion = client.getServerVersion()?.version
    return {
      capability, serverVersion, tools: toolNames,
      issues: validateExternalToolContract(capability, listed.tools, manifest, serverVersion),
    }
  } finally {
    controller.abort()
    await bounded(client.close(), 5_000)
  }
}

export async function checkConfiguredPlugins(home = runtimeHome()): Promise<PluginCheckResult[]> {
  const config = await readPluginConfig(home)
  const capabilities: ExternalCapability[] = ['files', 'knowledge', 'employeeTasks', 'bi']
  const results: PluginCheckResult[] = []
  for (const capability of capabilities) {
    if (!config.capabilities[capability].enabled) continue
    try { results.push(await checkOnePlugin(capability, config)) }
    catch (error) { results.push({ capability, tools: [], issues: [(error as Error).message] }) }
  }
  return results
}
