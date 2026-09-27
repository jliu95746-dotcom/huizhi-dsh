import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const target = join(root, 'dist')
if (dirname(target) !== root) throw new Error('dist 路径越界')
try {
  const entry = await lstat(target)
  if (entry.isSymbolicLink()) throw new Error('dist 是符号链接，拒绝清理')
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0)
  throw error
}
await rm(target, { recursive: true, force: true })
