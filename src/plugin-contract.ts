import type { Capability } from './contracts.js'

export const CONTRACT_VERSION = 1

interface ToolContract {
  input: Record<string, string>
  output: Record<string, string>
}

export const EXTERNAL_CONTRACTS: Record<Exclude<Capability, 'reports'>, Record<string, ToolContract>> = {
  files: {
    search_documents: { input: { query: 'string' }, output: { items: 'array', sourceRef: 'string', version: 'string' } },
    read_document: { input: { path: 'string' }, output: { content: 'string', sourceRef: 'string', version: 'string' } },
  },
  knowledge: {
    search_knowledge: { input: { query: 'string' }, output: { hits: 'array', sourceRef: 'string', version: 'string' } },
  },
  employeeTasks: {
    list_tasks: { input: {}, output: { tasks: 'array', sourceRef: 'string', version: 'string' } },
    submit_task: { input: { title: 'string', idempotencyKey: 'string' }, output: { externalTaskId: 'string', status: 'string', sourceRef: 'string', version: 'string' } },
    get_task_status: { input: { externalTaskId: 'string' }, output: { externalTaskId: 'string', status: 'string', sourceRef: 'string', version: 'string' } },
    cancel_task: { input: { externalTaskId: 'string' }, output: { externalTaskId: 'string', status: 'string', sourceRef: 'string', version: 'string' } },
  },
  bi: {
    list_metrics: { input: {}, output: { metrics: 'array', sourceRef: 'string', version: 'string' } },
    get_metrics: { input: { metricId: 'string' }, output: { metricId: 'string', value: 'number', asOf: 'string', sourceRef: 'string', version: 'string' } },
  },
}

export interface DeclaredTool {
  name: string
  description?: string
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] }
  outputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] }
}

function schemaIssues(schema: DeclaredTool['inputSchema'] | undefined, fields: Record<string, string>, direction: string): string[] {
  if (!schema || schema.type !== 'object') return [`${direction} 必须声明 object JSON Schema`]
  const issues: string[] = []
  for (const [field, expectedType] of Object.entries(fields)) {
    const property = schema.properties?.[field] as { type?: string } | undefined
    if (property?.type !== expectedType) issues.push(`${direction}.${field} 必须是 ${expectedType}`)
    if (!schema.required?.includes(field)) issues.push(`${direction}.${field} 必须为 required`)
  }
  return issues
}

export function validateExternalToolContract(
  capability: Exclude<Capability, 'reports'>,
  tools: DeclaredTool[],
  manifest: unknown,
  serverVersion: string | undefined,
): string[] {
  const issues: string[] = []
  if (!serverVersion || !/^\d+\.\d+\.\d+/.test(serverVersion)) issues.push('MCP server version 必须是语义版本')
  const meta = typeof manifest === 'object' && manifest !== null ? manifest as Record<string, unknown> : {}
  if (meta.contractVersion !== CONTRACT_VERSION) issues.push(`contractVersion 必须是 ${CONTRACT_VERSION}`)
  if (meta.capability !== capability) issues.push(`capability 必须是 ${capability}`)
  const expected = EXTERNAL_CONTRACTS[capability]
  const names = tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) issues.push('工具名称重复')
  const allowed = new Set(['describe_capability', ...Object.keys(expected)])
  for (const name of names) if (!allowed.has(name)) issues.push(`未声明的工具 ${name}`)
  const describe = tools.find((tool) => tool.name === 'describe_capability')
  if (!describe) issues.push('缺少 describe_capability')
  else {
    issues.push(...schemaIssues(describe.inputSchema, {}, 'describe_capability.inputSchema'))
    issues.push(...schemaIssues(describe.outputSchema, { contractVersion: 'integer', capability: 'string' }, 'describe_capability.outputSchema'))
  }
  for (const [name, contract] of Object.entries(expected)) {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) { issues.push(`缺少工具 ${name}`); continue }
    issues.push(...schemaIssues(tool.inputSchema, contract.input, `${name}.inputSchema`))
    issues.push(...schemaIssues(tool.outputSchema, contract.output, `${name}.outputSchema`))
  }
  return issues
}
