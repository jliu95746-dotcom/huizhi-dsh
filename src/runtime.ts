import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePluginConfig, type PluginConfig } from './contracts.js'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const profileName = 'huizhi-enterprise'

export function runtimeHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.HUIZHI_DSH_HOME || join(homedir(), '.dsh-huizhi'))
}

export function childEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']
  for (const name of (environment.HUIZHI_DSH_PASS_ENV ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`无效环境变量名 ${name}`)
    names.push(name)
  }
  return Object.fromEntries(names.flatMap((name) =>
    environment[name] === undefined ? [] : [[name, environment[name]]]))
}

async function copyIfMissing(source: string, destination: string, mode: number, requireMatch = false): Promise<void> {
  try {
    const existing = await readFile(destination)
    if (requireMatch && !existing.equals(await readFile(source))) {
      throw new Error(`企业 profile 与项目源码不一致：${destination}；请先检查差异再更新`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  }
  await chmod(destination, mode)
}

export async function setupRuntime(home = runtimeHome()): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const target = await realpath(home)
  const originalDsh = resolve(homedir(), '.dsh')
  if (target === originalDsh || target.startsWith(`${originalDsh}${sep}`)) {
    throw new Error('企业运行目录不能与原 DSH 目录重叠')
  }
  await chmod(home, 0o700)
  const profileDirectory = join(home, 'profiles', profileName)
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  await copyIfMissing(join(projectRoot, 'profile', 'package.json'), join(profileDirectory, 'package.json'), 0o600, true)
  await copyIfMissing(join(projectRoot, 'profile', 'cordis.patch.yml'), join(profileDirectory, 'cordis.patch.yml'), 0o600, true)
  await copyIfMissing(join(projectRoot, 'config', 'plugins.example.json'), join(home, 'plugins.json'), 0o600)
  const credentialSource = join(homedir(), '.dsh', '.credentials.yaml')
  try {
    await copyIfMissing(credentialSource, join(home, '.credentials.yaml'), 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const settingsSource = join(homedir(), '.dsh', 'settings.yaml')
  try {
    await copyIfMissing(settingsSource, join(home, 'settings.yaml'), 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(join(home, 'tasks'), { recursive: true, mode: 0o700 })
  await mkdir(join(home, 'outputs'), { recursive: true, mode: 0o700 })
  await cleanupStaleTasks(home)
}

export async function cleanupStaleTasks(home: string, minAgeMs = 60_000): Promise<number> {
  const tasksRoot = await realpath(join(home, 'tasks'))
  let removed = 0
  for (const entry of await readdir(tasksRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('run-') || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const target = join(tasksRoot, entry.name)
    if (dirname(target) !== tasksRoot || dirname(await realpath(target)) !== tasksRoot) continue
    const details = await lstat(target)
    if (Date.now() - details.mtimeMs < minAgeMs) continue
    let active = false
    try {
      const owner = JSON.parse(await readFile(join(target, 'owner.json'), 'utf8')) as { pid?: unknown }
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); active = true }
        catch (error) { active = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (active) continue
    await rm(target, { recursive: true, force: true })
    removed++
  }
  return removed
}

export async function readPluginConfig(home = runtimeHome()): Promise<PluginConfig> {
  return parsePluginConfig(JSON.parse(await readFile(join(home, 'plugins.json'), 'utf8')))
}

export async function writePrivateFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { flag: 'wx', mode: 0o600 })
}
