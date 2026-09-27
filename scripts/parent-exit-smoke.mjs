import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { projectRoot } from '../dist/src/runtime.js'

if (process.platform !== 'linux') throw new Error('此测试仅适用于 Ubuntu/Linux')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function childPidOf(pid) {
  try {
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
    return Number(children.trim().split(/\s+/)[0]) || undefined
  } catch { return undefined }
}
async function alive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.split(') ')[1]?.[0] !== 'Z'
  } catch { return false }
}

const parent = spawn(process.execPath, [join(projectRoot, 'dist', 'src', 'cli.js'), 'run', '--input', join(projectRoot, 'examples', 'echo-task.json')], {
  cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
})
let dshPid
try {
  const started = new Promise((resolve, reject) => {
    let output = ''
    parent.stdout.setEncoding('utf8')
    parent.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('"type":"started"')) resolve()
    })
    parent.on('error', reject)
    parent.on('exit', () => reject(new Error('任务入口在 started 前退出')))
  })
  await Promise.race([started, wait(20000).then(() => { throw new Error('任务入口启动超时') })])
  for (let attempt = 0; attempt < 100; attempt++) {
    dshPid = await childPidOf(parent.pid)
    if (dshPid) break
    await wait(100)
  }
  assert.ok(dshPid, '未发现 DSH 子进程')
  parent.kill('SIGKILL')
  if (parent.exitCode === null) await once(parent, 'exit')
  let stopped = false
  for (let attempt = 0; attempt < 600; attempt++) {
    if (!await alive(dshPid)) { stopped = true; break }
    await wait(100)
  }
  assert.ok(stopped, `父进程退出后 DSH 子进程 ${dshPid} 仍在运行`)
  process.stdout.write(`${JSON.stringify({ status: 'passed', parentExited: true, childReaped: true })}\n`)
} finally {
  if (parent.exitCode === null) parent.kill('SIGKILL')
  if (dshPid && await alive(dshPid)) process.kill(dshPid, 'SIGTERM')
}
