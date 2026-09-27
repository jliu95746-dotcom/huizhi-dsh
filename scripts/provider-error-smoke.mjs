import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runTask } from '../dist/src/runner.js'

const status = Number(process.argv[2] ?? 401)
if (![401, 429].includes(status)) throw new Error('仅支持模拟 HTTP 401 或 429')
const home = await mkdtemp(join(homedir(), '.dsh-huizhi-provider-'))
if (dirname(home) !== homedir() || !basename(home).startsWith('.dsh-huizhi-provider-')) throw new Error('测试目录越界')
let requests = 0
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end()
    return
  }
  requests++
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...(status === 429 ? { 'Retry-After': '0' } : {}),
  })
  response.end(JSON.stringify({ error: {
    type: status === 401 ? 'authentication_error' : 'rate_limit_error',
    message: `模拟 HTTP ${status}`,
  } }))
})
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`
  process.env.HUIZHI_DSH_PASS_ENV = 'DEEPSEEK_BASE_URL'
  const events = []
  await assert.rejects(runTask({
    version: 1, taskId: `provider-${status}`, organizationId: 'demo-org', requesterId: 'demo-user',
    prompt: '请只回答：测试。', capabilities: [],
  }, { home, timeoutMs: 100_000, onEvent: (event) => events.push(event) }))
  assert.ok(requests > 0, '模拟 API 未收到请求，不能证明错误路径')
  assert.equal(events.at(-1)?.type, 'failed')
  assert.ok(!events.some((event) => event.type === 'completed'))
  process.stdout.write(`${JSON.stringify({ status: 'passed', mockedHttpStatus: status, requests, lastEvent: events.at(-1)?.type })}\n`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(home, { recursive: true, force: true })
  delete process.env.DEEPSEEK_BASE_URL
  delete process.env.HUIZHI_DSH_PASS_ENV
}
