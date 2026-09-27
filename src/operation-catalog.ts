import { CAPABILITIES, type Capability } from './contracts.js'
import { EXTERNAL_CONTRACTS } from './plugin-contract.js'
import { DispatchError, freeze, identifier, object, type Operation } from './command-contracts.js'

const pluginTools: Record<Capability, string[]> = {
  files: Object.keys(EXTERNAL_CONTRACTS.files), knowledge: Object.keys(EXTERNAL_CONTRACTS.knowledge),
  employeeTasks: Object.keys(EXTERNAL_CONTRACTS.employeeTasks), bi: Object.keys(EXTERNAL_CONTRACTS.bi),
  reports: ['create_weekly_report'],
}
const writeTools = new Set(['submit_task', 'cancel_task', 'create_weekly_report'])

export class OperationCatalog {
  readonly #operations = new Map<string, Operation>()
  constructor(custom: unknown = []) {
    for (const capability of CAPABILITIES) {
      for (const tool of pluginTools[capability]) {
        const id = `${capability}.${tool}`
        this.#operations.set(id, freeze({ id, description: `DSH 插件操作 ${id}`, executor: 'dsh',
          effect: writeTools.has(tool) ? 'write' : 'read', capability, tool }))
      }
    }
    if (!Array.isArray(custom)) throw new DispatchError('INVALID_CATALOG', '功能清单必须是数组')
    for (const raw of custom) {
      const input = object(raw, '功能')
      const id = identifier(input.id, '功能编号')
      if (this.#operations.has(id)) throw new DispatchError('INVALID_CATALOG', `功能编号重复或试图覆盖内置插件：${id}`)
      if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 500 || !['read', 'write'].includes(String(input.effect))) {
        throw new DispatchError('INVALID_CATALOG', `${id} 需要 description 和 effect(read/write)`)
      }
      if (input.executor !== 'business' && input.executor !== 'dsh') throw new DispatchError('INVALID_CATALOG', `${id} 的 executor 无效`)
      const operation: Operation = { id, description: input.description, executor: input.executor, effect: input.effect as 'read' | 'write' }
      if (input.executor === 'business') {
        if (CAPABILITIES.some((name) => id.startsWith(`${name}.`)) || input.capability !== undefined || input.tool !== undefined) {
          throw new DispatchError('INVALID_CATALOG', `${id} 不能把插件功能登记为普通业务`)
        }
      } else {
        const capability = input.capability as Capability
        if (!CAPABILITIES.includes(capability) || typeof input.tool !== 'string' || !pluginTools[capability].includes(input.tool)) {
          throw new DispatchError('INVALID_CATALOG', `${id} 必须指向已知 DSH 插件工具`)
        }
        operation.capability = capability
        operation.tool = input.tool
        operation.effect = writeTools.has(input.tool) ? 'write' : 'read'
      }
      this.#operations.set(id, freeze(operation))
    }
  }
  get(id: string): Operation {
    const operation = this.#operations.get(id)
    if (!operation) throw new DispatchError('UNKNOWN_OPERATION', `未登记功能：${id}`)
    return operation
  }
  list(): Operation[] { return [...this.#operations.values()] }
}
export function createOperationCatalog(custom: unknown = []): OperationCatalog { return new OperationCatalog(custom) }
export function parseOperationCatalog(raw: unknown): OperationCatalog {
  const input = object(raw, '功能清单配置')
  if (input.version !== 1) throw new DispatchError('INVALID_CATALOG', '功能清单 version 必须是 1')
  if (!Array.isArray(input.operations)) throw new DispatchError('INVALID_CATALOG', '功能清单 operations 必须是数组')
  return createOperationCatalog(input.operations)
}
