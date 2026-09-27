import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCommandDispatcher } from '../src/command-dispatcher.js'
import { createOperationCatalog } from '../src/operation-catalog.js'

const stateDirectory = process.argv[2]
const dispatcher = createCommandDispatcher({
  stateDirectory,
  catalog: createOperationCatalog([{ id: 'employee.profile.update', executor: 'business', description: '修改员工资料', effect: 'write' }]),
  authorize: async () => ({ allowed: true, capabilities: ['reports'] }),
  businessHandlers: { 'employee.profile.update': async () => {
    await appendFile(join(stateDirectory, 'effect.txt'), 'saved\n', { mode: 0o600 })
    process.exit(17)
  } },
})
await dispatcher.dispatchCommand({ version: 1, requestId: 'crash-request', kind: 'action',
  operationId: 'employee.profile.update', parameters: { employeeId: 'employee-1', name: '示例员工' } },
{ source: 'desktop', organizationId: 'org-1', requesterId: 'user-1', authorizationRef: 'grant-1' })
