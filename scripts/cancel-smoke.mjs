import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runTask } from '../dist/src/runner.js'

const home = await mkdtemp(join(homedir(), '.dsh-huizhi-cancel-'))
if (dirname(home) !== homedir() || !basename(home).startsWith('.dsh-huizhi-cancel-')) {
  throw new Error('测试目录越界')
}
const controller = new AbortController()
const events = []
try {
  await assert.rejects(runTask({
    version: 1, taskId: 'cancel-001', organizationId: 'demo-org', requesterId: 'demo-user',
    prompt: '只回答：已连接。', capabilities: [],
  }, {
    home, signal: controller.signal, timeoutMs: 120000,
    onEvent: (event) => {
      events.push(event.type)
      if (event.type === 'started') controller.abort()
    },
  }), /任务已取消/)
  assert.deepEqual(events, ['started', 'cancelled'])
  process.stdout.write(`${JSON.stringify({ status: 'passed', events })}\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}
