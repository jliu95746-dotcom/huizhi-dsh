import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const execute = promisify(execFile)
const home = process.env.HUIZHI_DSH_HOME || join(homedir(), '.dsh-huizhi')
const dsh = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const { stdout } = await execute(process.execPath, [dsh, '--profile', 'huizhi-enterprise', '--dump-config'], {
  env: { ...process.env, DSH_HOME: home },
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024,
})
const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (value) => value,
})])
const rows = yaml.load(stdout, { schema })
if (!Array.isArray(rows)) throw new Error('DSH profile 组合结果不是数组')
const enabledModelTools = rows.filter((row) => row && typeof row === 'object' &&
  typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/dsh-tool-') &&
  !['@deepseek-ai/dsh-tool-call-timeout-policy'].includes(row.name) && row.disabled !== true)
const sdk = rows.some((row) => row?.id === 'sdk-jsonrpc-server' && row.disabled !== true)
const expectedDisabled = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill',
  'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-web',
]
const missing = expectedDisabled.filter((id) => !rows.some((row) => row?.id === id && row.disabled === true))
const result = { sdk, enabledModelTools: enabledModelTools.map((row) => row.id), missingDisabledRows: missing }
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!sdk || enabledModelTools.length || missing.length) process.exitCode = 1
