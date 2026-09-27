export const CAPABILITIES = ['files', 'knowledge', 'employeeTasks', 'bi', 'reports'] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface TaskRequest {
  version: 1
  taskId: string
  organizationId: string
  requesterId: string
  authorizationRef?: string
  prompt: string
  capabilities: Capability[]
}

export interface StdioServerConfig {
  enabled: true
  transport: 'stdio'
  command: string
  args: string[]
  envFrom?: Record<string, string>
  toolCallTimeoutMs?: number
}

export interface HttpServerConfig {
  enabled: true
  transport: 'streamable-http'
  url: string
  headersFrom?: Record<string, string>
  toolCallTimeoutMs?: number
}

export type ExternalCapabilityConfig = { enabled: false; toolCallTimeoutMs?: never } | StdioServerConfig | HttpServerConfig

export interface PluginConfig {
  version: 1
  capabilities: {
    files: ExternalCapabilityConfig
    knowledge: ExternalCapabilityConfig
    employeeTasks: ExternalCapabilityConfig
    bi: ExternalCapabilityConfig
    reports: { enabled: boolean; toolCallTimeoutMs?: number }
  }
}

interface McpPatchConfig {
  serverName: Capability
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect: { enabled: boolean }
}

export interface McpPatch {
  insert: Array<{
    id: string
    name: '@deepseek-ai/dsh-mcp-client'
    config: McpPatchConfig
  }>
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function boundedText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} 必须是非空字符串，且最多 ${maxLength} 字符`)
  }
  return value.trim()
}

function identifier(value: unknown, name: string): string {
  const text = boundedText(value, name, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw new Error(`${name} 只能使用 ASCII 字母、数字、点、下划线、冒号和连字符`)
  }
  return text
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

export function parseTaskRequest(value: unknown): TaskRequest {
  const input = record(value, '任务')
  if (input.version !== 1) throw new Error('任务 version 必须是 1')
  if (!Array.isArray(input.capabilities) || !input.capabilities.every(isCapability)) {
    throw new Error('capabilities 必须是已知能力名称数组')
  }
  const capabilities = input.capabilities as Capability[]
  if (new Set(capabilities).size !== capabilities.length) throw new Error('capabilities 包含重复能力')
  return {
    version: 1,
    taskId: identifier(input.taskId, 'taskId'),
    organizationId: identifier(input.organizationId, 'organizationId'),
    requesterId: identifier(input.requesterId, 'requesterId'),
    ...(input.authorizationRef === undefined ? {} : {
      authorizationRef: (() => {
        const reference = boundedText(input.authorizationRef, 'authorizationRef', 512)
        if (!/^[\x20-\x7E]+$/.test(reference)) throw new Error('authorizationRef 只能使用单行 ASCII 文本')
        return reference
      })(),
    }),
    prompt: boundedText(input.prompt, 'prompt', 20_000),
    capabilities,
  }
}

function stringMap(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const input = record(value, name)
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new Error(`${name} 包含无效名称 ${key}`)
    output[key] = boundedText(item, `${name}.${key}`, 256)
  }
  return output
}

function toolTimeout(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 300_000) {
    throw new Error(`${name}.toolCallTimeoutMs 必须是 100 到 300000 之间的整数`)
  }
  return value as number
}

function parseExternalCapability(value: unknown, name: Capability): ExternalCapabilityConfig {
  const input = record(value, name)
  if (input.enabled === false) return { enabled: false }
  if (input.enabled !== true) throw new Error(`${name}.enabled 必须是布尔值`)
  if (input.transport === 'stdio') {
    if (!Array.isArray(input.args) || !input.args.every((item) => typeof item === 'string')) {
      throw new Error(`${name}.args 必须是字符串数组`)
    }
    return {
      enabled: true,
      transport: 'stdio',
      command: boundedText(input.command, `${name}.command`, 1024),
      args: [...input.args],
      ...(input.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: toolTimeout(input.toolCallTimeoutMs, name) }),
      ...(input.envFrom === undefined ? {} : { envFrom: stringMap(input.envFrom, `${name}.envFrom`) }),
    }
  }
  if (input.transport === 'streamable-http') {
    const url = boundedText(input.url, `${name}.url`, 2048)
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name}.url 必须使用 HTTP(S)`)
    return {
      enabled: true,
      transport: 'streamable-http',
      url,
      ...(input.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: toolTimeout(input.toolCallTimeoutMs, name) }),
      ...(input.headersFrom === undefined ? {} : { headersFrom: stringMap(input.headersFrom, `${name}.headersFrom`) }),
    }
  }
  throw new Error(`${name}.transport 必须是 stdio 或 streamable-http`)
}

export function parsePluginConfig(value: unknown): PluginConfig {
  const input = record(value, '插件配置')
  if (input.version !== 1) throw new Error('插件配置 version 必须是 1')
  const capabilities = record(input.capabilities, 'capabilities')
  const reports = record(capabilities.reports, 'reports')
  if (typeof reports.enabled !== 'boolean') throw new Error('reports.enabled 必须是布尔值')
  const reportsTimeout = toolTimeout(reports.toolCallTimeoutMs, 'reports')
  return {
    version: 1,
    capabilities: {
      files: parseExternalCapability(capabilities.files, 'files'),
      knowledge: parseExternalCapability(capabilities.knowledge, 'knowledge'),
      employeeTasks: parseExternalCapability(capabilities.employeeTasks, 'employeeTasks'),
      bi: parseExternalCapability(capabilities.bi, 'bi'),
      reports: { enabled: reports.enabled, ...(reportsTimeout === undefined ? {} : { toolCallTimeoutMs: reportsTimeout }) },
    },
  }
}

export function resolveCapabilities(task: TaskRequest, plugins: PluginConfig): Capability[] {
  for (const capability of task.capabilities) {
    if (!plugins.capabilities[capability].enabled) throw new Error(`${capability} 插件未启用`)
  }
  return [...task.capabilities]
}

export function buildTaskPluginPatch(
  task: TaskRequest,
  plugins: PluginConfig,
  reportServerPath: string,
  outputDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): McpPatch[] {
  const capabilities = resolveCapabilities(task, plugins)
  const context = Buffer.from(JSON.stringify({
    taskId: task.taskId,
    organizationId: task.organizationId,
    requesterId: task.requesterId,
    authorizationRef: task.authorizationRef,
  }), 'utf8').toString('base64')
  const insert: McpPatch['insert'] = []
  for (const capability of capabilities) {
    const selected = plugins.capabilities[capability] as ExternalCapabilityConfig
    const common: McpPatchConfig = {
      serverName: capability,
      transport: 'stdio',
      env: { HUIZHI_TASK_CONTEXT_B64: context },
      toolCallTimeoutMs: plugins.capabilities[capability].toolCallTimeoutMs ?? 60_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
    if (capability === 'reports') {
      common.command = process.execPath
      common.args = [reportServerPath]
      common.env!.HUIZHI_OUTPUT_DIR = outputDirectory
    } else if (selected.enabled && selected.transport === 'stdio') {
      common.command = selected.command
      common.args = selected.args
      for (const [destination, source] of Object.entries(selected.envFrom ?? {})) {
        const secret = environment[source]
        if (!secret) throw new Error(`${capability} 缺少环境变量 ${source}`)
        common.env![destination] = secret
      }
    } else if (selected.enabled && selected.transport === 'streamable-http') {
      common.transport = 'streamable-http'
      common.url = selected.url
      delete common.env
      common.headers = {
        'X-Huizhi-Task-Id': task.taskId,
        'X-Huizhi-Organization-Id': task.organizationId,
        'X-Huizhi-Requester-Id': task.requesterId,
        ...(task.authorizationRef ? { 'X-Huizhi-Authorization-Ref': task.authorizationRef } : {}),
      }
      for (const [header, source] of Object.entries(selected.headersFrom ?? {})) {
        const secret = environment[source]
        if (!secret) throw new Error(`${capability} 缺少环境变量 ${source}`)
        common.headers[header] = secret
      }
    }
    insert.push({ id: `huizhi-mcp-${capability}`, name: '@deepseek-ai/dsh-mcp-client', config: common })
  }
  return [{ insert }]
}
