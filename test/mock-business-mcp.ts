import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { EXTERNAL_CONTRACTS, CONTRACT_VERSION } from '../src/plugin-contract.js'
import { projectRoot } from '../src/runtime.js'

const capability = process.argv[2] as keyof typeof EXTERNAL_CONTRACTS
const contract = EXTERNAL_CONTRACTS[capability]
if (!contract) throw new Error('未知测试能力')
const taskContext = JSON.parse(Buffer.from(process.env.HUIZHI_TASK_CONTEXT_B64 || '', 'base64').toString('utf8')) as {
  taskId: string; organizationId: string; requesterId: string
}
if (!taskContext.taskId || !taskContext.organizationId || !taskContext.requesterId) {
  throw new Error('测试插件缺少任务身份')
}

function schema(fields: Record<string, string>) {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { type }])),
    required: Object.keys(fields),
    additionalProperties: true,
  }
}

const definitions = [
  {
    name: 'describe_capability', description: '返回插件能力与契约版本',
    inputSchema: schema({}), outputSchema: schema({ contractVersion: 'integer', capability: 'string' }),
  },
  ...Object.entries(contract).map(([name, fields]) => ({
    name, description: `示例 ${capability} 业务操作 ${name}`,
    inputSchema: schema(fields.input), outputSchema: schema(fields.output),
  })),
]
const server = new Server({ name: `huizhi-mock-${capability}`, version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments ?? {}
  let data: Record<string, unknown>
  if (name === 'describe_capability') {
    data = { contractVersion: CONTRACT_VERSION, capability }
  } else if (!(name in contract)) {
    return { isError: true, content: [{ type: 'text', text: '未知工具' }] }
  } else if (capability === 'files' && name === 'read_document') {
    if (args.path === 'crash.txt') process.exit(17)
    if (args.path === 'slow.txt') {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      data = { sourceRef: 'slow.txt', version: 'fixture-v1', content: '故意延迟的测试文件' }
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
    }
    if (args.path !== 'weekly/2026-09-21.txt') {
      return { isError: true, content: [{ type: 'text', text: '文件未授权或不存在' }] }
    }
    data = {
      sourceRef: 'weekly/2026-09-21.txt', version: 'fixture-v1',
      content: await readFile(join(projectRoot, 'fixtures', 'weekly', '2026-09-21.txt'), 'utf8'),
    }
  } else if (capability === 'files') {
    data = { sourceRef: 'weekly/2026-09-21.txt', version: 'fixture-v1', items: [{ path: 'weekly/2026-09-21.txt', title: '示例周记录' }] }
  } else if (capability === 'knowledge') {
    data = {
      sourceRef: 'knowledge/服务流程.txt', version: 'fixture-v1',
      hits: [{ text: await readFile(join(projectRoot, 'fixtures', 'knowledge', '服务流程.txt'), 'utf8'), sourceRef: 'knowledge/服务流程.txt' }],
    }
  } else if (capability === 'employeeTasks' && name === 'list_tasks') {
    data = { sourceRef: 'employeeTasks/demo-001', version: 'fixture-v1', tasks: [{ externalTaskId: 'demo-001', title: '审核 4 条常见问题', status: 'pending' }] }
  } else if (capability === 'employeeTasks') {
    data = {
      sourceRef: 'employeeTasks/demo-001', version: 'fixture-v1', externalTaskId: 'demo-001',
      status: name === 'cancel_task' ? 'cancelled' : 'pending',
    }
  } else if (capability === 'bi' && name === 'list_metrics') {
    data = { sourceRef: 'bi/catalog', version: 'fixture-v1', metrics: [{ metricId: 'faq_review', name: '已审核常见问题数' }] }
  } else {
    if (args.metricId !== 'faq_review') return { isError: true, content: [{ type: 'text', text: '指标不存在' }] }
    data = { sourceRef: 'bi/demo-2026-09-21', version: 'fixture-v1', metricId: 'faq_review', value: 16, asOf: '2026-09-21', totalFaqs: 20 }
  }
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
})
await server.connect(new StdioServerTransport())
