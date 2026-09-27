// 仅用于虚构数据演示。主程序须替换 authorize 和 businessHandlers，不能直接用于生产鉴权。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseOperationCatalog } from '../dist/src/operation-catalog.js'

export default {
  stateDirectory: process.env.HUIZHI_ROUTING_DEMO_STATE || join(homedir(), '.dsh-huizhi-routing-demo', 'requests'),
  catalog: parseOperationCatalog(JSON.parse(await readFile(new URL('../config/operations.example.json', import.meta.url), 'utf8'))),
  authorize: async ({ context, command }) => ({
    allowed: context.organizationId === 'demo-org' && context.requesterId === 'demo-user' &&
      (command.kind === 'instruction' || command.operationId !== 'employee.profile.update' || command.parameters.employeeId === 'demo-employee'),
    capabilities: ['reports'],
  }),
  businessHandlers: {
    'employee.profile.update': async ({ parameters, idempotencyKey, signal }) => {
      signal.throwIfAborted()
      if (typeof parameters.name !== 'string' || !parameters.name.trim()) throw new Error('示例员工姓名不能为空')
      return { demonstration: true, message: '已走普通业务处理路径；本示例没有修改真实员工数据', employeeId: 'demo-employee', idempotencyKey }
    },
  },
  // 主程序接入自己的 desktopAgent；默认不把电脑自然语言自动转给 DSH。
}
