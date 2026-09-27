#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCommandDispatcher, type DispatcherDependencies } from './command-dispatcher.js'
import type { TrustedContext } from './command-contracts.js'
import { parseTaskRequest } from './contracts.js'
import { checkConfiguredPlugins } from './check-plugins.js'
import { runTask } from './runner.js'
import { profileName, projectRoot, readPluginConfig, runtimeHome, setupRuntime } from './runtime.js'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1]) throw new Error(`${name} 缺少参数`)
  return args[index + 1]
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const home = runtimeHome()
  if (command === 'setup') {
    await setupRuntime(home)
    send({ status: 'ready', home, profile: profileName, pluginConfig: join(home, 'plugins.json') })
    return
  }
  if (command === 'doctor') {
    const profileDirectory = join(home, 'profiles', profileName)
    const [installedPackage, sourcePackage, installedPatch, sourcePatch] = await Promise.all([
      readFile(join(profileDirectory, 'package.json')).catch(() => Buffer.alloc(0)),
      readFile(join(projectRoot, 'profile', 'package.json')),
      readFile(join(profileDirectory, 'cordis.patch.yml')).catch(() => Buffer.alloc(0)),
      readFile(join(projectRoot, 'profile', 'cordis.patch.yml')),
    ])
    const homeStat = await stat(home).catch(() => undefined)
    const credentialStat = await stat(join(home, '.credentials.yaml')).catch(() => undefined)
    const checks = {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      profile: await exists(join(profileDirectory, 'cordis.patch.yml')),
      profileCurrent: installedPackage.equals(sourcePackage) && installedPatch.equals(sourcePatch),
      credentials: await exists(join(home, '.credentials.yaml')),
      privateHome: ((homeStat?.mode ?? 0) & 0o777) === 0o700,
      privateCredentials: ((credentialStat?.mode ?? 0) & 0o777) === 0o600,
      pluginConfig: await exists(join(home, 'plugins.json')),
    }
    let configured: unknown = null
    if (checks.pluginConfig) {
      const config = await readPluginConfig(home)
      configured = Object.fromEntries(Object.entries(config.capabilities).map(([name, value]) => [name, value.enabled]))
    }
    send({ checks, configured })
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) ||
      !checks.profile || !checks.profileCurrent || !checks.credentials || !checks.privateHome ||
      !checks.privateCredentials || !checks.pluginConfig) {
      process.exitCode = 1
    }
    return
  }
  if (command === 'plugins' && args[0] === 'list') {
    const config = await readPluginConfig(home)
    send({ capabilities: Object.fromEntries(Object.entries(config.capabilities).map(([name, value]) => [name, {
      enabled: value.enabled,
      transport: 'transport' in value ? value.transport : 'builtin',
    }])) })
    return
  }
  if (command === 'plugins' && args[0] === 'check') {
    const results = await checkConfiguredPlugins(home)
    send({ results })
    if (results.some((result) => result.issues.length)) process.exitCode = 1
    return
  }
  if (command === 'dispatch') {
    const inputPath = option(args, '--input')
    const contextPath = option(args, '--context')
    const adapterPath = option(args, '--adapter')
    if (!inputPath || !contextPath || !adapterPath) throw new Error('dispatch 必须指定 --input、--context 和服务端受信任的 --adapter')
    const format = option(args, '--format') ?? 'jsonl'
    if (!['jsonl', 'text'].includes(format)) throw new Error('--format 必须是 jsonl 或 text')
    // The adapter path is selected by the server/operator, never by an HTTP request body.
    const adapter = await import(pathToFileURL(resolve(adapterPath)).href) as { default: DispatcherDependencies }
    const dispatcher = createCommandDispatcher(adapter.default)
    const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'))
    const context = JSON.parse(await readFile(contextPath, 'utf8')) as TrustedContext
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const result = await dispatcher.dispatchCommand(input, context, {
        signal: controller.signal, timeoutMs: Number(option(args, '--timeout-ms') ?? 600_000),
        onEvent: format === 'jsonl' ? send : undefined,
      })
      if (format === 'jsonl') send({ type: 'result', ...result })
      else process.stdout.write(`执行路径：${result.route}\n重复请求：${result.replayed ? '是，返回已有结果' : '否'}\n${JSON.stringify(result.value, null, 2)}\n`)
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    }
    return
  }
  if (command === 'run') {
    const inputPath = option(args, '--input')
    if (!inputPath) throw new Error('run 必须指定 --input <任务 JSON 文件>')
    const format = option(args, '--format') ?? 'jsonl'
    if (!['jsonl', 'text'].includes(format)) throw new Error('--format 必须是 jsonl 或 text')
    const task = parseTaskRequest(JSON.parse(await readFile(inputPath, 'utf8')))
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try {
      await runTask(task, {
        home,
        timeoutMs: Number(option(args, '--timeout-ms') ?? 600_000),
        signal: controller.signal,
        onEvent: format === 'jsonl' ? send : (event) => {
          if (event.type === 'completed') {
            process.stdout.write(`${event.response}\n`)
            if (event.artifacts.length) process.stdout.write(`\n生成文件：\n${event.artifacts.join('\n')}\n`)
          } else if (event.type === 'failed' || event.type === 'cancelled' || event.type === 'timed_out') {
            process.stderr.write(`${event.type}: ${event.error}\n`)
          }
        },
      })
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
    return
  }
  process.stdout.write('用法: huizhi-dsh setup | doctor | plugins list | plugins check | run --input task.json | dispatch --input command.json --context trusted-context.json --adapter server-adapter.mjs [--format jsonl|text] [--timeout-ms 600000]\n')
  if (command) process.exitCode = 2
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
  process.exitCode = 1
})
