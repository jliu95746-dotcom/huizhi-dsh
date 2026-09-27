import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { childEnvironment, cleanupStaleTasks } from '../src/runtime.js'

test('DSH 子进程默认不继承其他服务的密钥', () => {
  const result = childEnvironment({ HOME: '/home/dev', PATH: '/usr/bin', OTHER_SERVICE_TOKEN: 'secret' })
  assert.deepEqual(result, { PATH: '/usr/bin', HOME: '/home/dev' })
})

test('部署者可以明确传入代理环境变量', () => {
  const result = childEnvironment({ HUIZHI_DSH_PASS_ENV: 'HTTPS_PROXY,NO_PROXY', HTTPS_PROXY: 'proxy', NO_PROXY: 'localhost' })
  assert.deepEqual(result, { HTTPS_PROXY: 'proxy', NO_PROXY: 'localhost' })
})

test('只清理失活任务的私有临时目录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'huizhi-clean-test-'))
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('huizhi-clean-test-')) throw new Error('测试目录越界')
  try {
    const tasksRoot = join(home, 'tasks')
    await mkdir(join(tasksRoot, 'run-stale'), { recursive: true })
    await mkdir(join(tasksRoot, 'run-active'))
    await writeFile(join(tasksRoot, 'run-stale', 'owner.json'), JSON.stringify({ pid: 2_000_000_000 }))
    await writeFile(join(tasksRoot, 'run-active', 'owner.json'), JSON.stringify({ pid: process.pid }))
    assert.equal(await cleanupStaleTasks(home, 0), 1)
    assert.deepEqual(await readdir(tasksRoot), ['run-active'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
