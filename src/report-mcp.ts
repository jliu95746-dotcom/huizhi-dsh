import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { renderWeeklyReport, validateWeeklyReportInput } from './report.js'

const outputDirectory = process.env.HUIZHI_OUTPUT_DIR
if (!outputDirectory) throw new Error('HUIZHI_OUTPUT_DIR 未设置')

const itemSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '一条事实或计划' },
    sourceRefs: { type: 'array', items: { type: 'string' }, minItems: 1, description: '来源文件或业务记录标识' },
  },
  required: ['text', 'sourceRefs'],
  additionalProperties: false,
} as const

const server = new Server({ name: 'huizhi-reports', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'create_weekly_report',
    description: '根据已知事实生成中文 Markdown 周报。每条内容必须带来源标识。',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
        completed: { type: 'array', items: itemSchema },
        risks: { type: 'array', items: itemSchema },
        nextWeek: { type: 'array', items: itemSchema },
      },
      required: ['period', 'completed', 'risks', 'nextWeek'],
      additionalProperties: false,
    },
  }],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'create_weekly_report') {
    return { isError: true, content: [{ type: 'text', text: '未知报表工具' }] }
  }
  try {
    const input = validateWeeklyReportInput(request.params.arguments)
    const markdown = renderWeeklyReport(input)
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    const path = resolve(outputDirectory, `weekly-${randomUUID()}.md`)
    await writeFile(path, markdown, { flag: 'wx', mode: 0o600 })
    return { content: [{ type: 'text', text: JSON.stringify({ path, format: 'markdown', period: input.period }) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }
  }
})

await server.connect(new StdioServerTransport())
