import { parseTaskRequest, type Capability } from './contracts.js'
import type { TaskEvent } from './runner.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type ClientSource = 'desktop' | 'mobile'
export interface TrustedContext {
  source: ClientSource
  organizationId: string
  requesterId: string
  authorizationRef?: string
}
export type Command =
  | { version: 1; requestId: string; kind: 'action'; operationId: string; parameters: JsonObject }
  | { version: 1; requestId: string; kind: 'instruction'; prompt: string }
export type CommandRoute = 'desktop_direct' | 'desktop_agent' | 'enterprise_direct' | 'enterprise_dsh'
export interface Operation {
  id: string
  description: string
  executor: 'business' | 'dsh'
  effect: 'read' | 'write'
  capability?: Capability
  tool?: string
}
export interface DispatchResult {
  version: 1
  requestId: string
  route: CommandRoute
  value: JsonValue
  replayed: boolean
}
export interface DispatchEvent {
  type: 'accepted' | 'routed' | 'enterprise_entered' | 'dsh_event' | 'completed' | 'failed' | 'replayed'
  requestId: string
  source: ClientSource
  route?: CommandRoute
  operationId?: string
  code?: string
  dshEvent?: TaskEvent
}
export interface DispatchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onEvent?: (event: DispatchEvent) => void
}
export class DispatchError extends Error {
  constructor(readonly code: string, message: string, readonly pendingConfirmation = false) {
    super(message)
    this.name = 'DispatchError'
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DispatchError('INVALID_COMMAND', `${label} 必须是对象`)
  return value as Record<string, unknown>
}
export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DispatchError('INVALID_COMMAND', `${label} 必须是最多 128 字符的 ASCII 标识符`)
  }
  return value
}
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 20) throw new DispatchError('INVALID_COMMAND', 'JSON 嵌套过深')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`).join(',')}}`
  }
  throw new DispatchError('INVALID_COMMAND', '只接受可序列化的 JSON 数据')
}
export function jsonSnapshot(value: unknown, maxBytes = 1_000_000): JsonValue {
  const text = canonicalJson(value)
  if (Buffer.byteLength(text) > maxBytes) throw new DispatchError('INVALID_COMMAND', `JSON 数据超过 ${maxBytes} 字节`)
  return JSON.parse(text) as JsonValue
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

export function parseCommand(raw: unknown): Command {
  const input = object(raw, '命令')
  const keys = input.kind === 'action'
    ? ['version', 'requestId', 'kind', 'operationId', 'parameters']
    : ['version', 'requestId', 'kind', 'prompt']
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw new DispatchError('INVALID_COMMAND', `命令不能包含 ${key}`)
  }
  if (input.version !== 1) throw new DispatchError('INVALID_COMMAND', '命令 version 必须是 1')
  const requestId = identifier(input.requestId, 'requestId')
  if (input.kind === 'action') {
    object(input.parameters, 'parameters')
    return freeze({ version: 1, requestId, kind: 'action', operationId: identifier(input.operationId, 'operationId'),
      parameters: jsonSnapshot(input.parameters, 16_000) as JsonObject })
  }
  if (input.kind === 'instruction' && typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 20_000) {
    return freeze({ version: 1, requestId, kind: 'instruction', prompt: input.prompt.trim() })
  }
  throw new DispatchError('INVALID_COMMAND', 'kind 必须是 action 或 instruction；自然语言 prompt 须为 1 至 20000 字符')
}

/** Context is supplied by the authenticated server, never copied from a request body. */
export function parseTrustedContext(raw: TrustedContext): TrustedContext {
  if (!raw || typeof raw !== 'object') throw new DispatchError('INVALID_CONTEXT', '主程序必须提供可信上下文')
  if (raw.source !== 'desktop' && raw.source !== 'mobile') throw new DispatchError('INVALID_CONTEXT', '客户端来源必须由主程序确认')
  try {
    const task = parseTaskRequest({ version: 1, taskId: 'context-check', prompt: '检查上下文', capabilities: [],
      organizationId: raw.organizationId, requesterId: raw.requesterId, authorizationRef: raw.authorizationRef })
    return freeze({ source: raw.source, organizationId: task.organizationId, requesterId: task.requesterId,
      ...(task.authorizationRef ? { authorizationRef: task.authorizationRef } : {}) })
  } catch (error) { throw new DispatchError('INVALID_CONTEXT', (error as Error).message) }
}

export function selectRoute(command: Command, context: TrustedContext, operation?: Operation): CommandRoute {
  if (operation?.executor === 'dsh') return 'enterprise_dsh'
  if (context.source === 'mobile') return command.kind === 'action' ? 'enterprise_direct' : 'enterprise_dsh'
  return command.kind === 'action' ? 'desktop_direct' : 'desktop_agent'
}
