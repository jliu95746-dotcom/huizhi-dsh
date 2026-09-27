import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DispatchError, type Command, type CommandRoute, type DispatchResult, type TrustedContext } from './command-contracts.js'

export interface RequestRecord {
  version: 1
  requestId: string
  organizationId: string
  requesterId: string
  source: TrustedContext['source']
  operationId?: string
  route: CommandRoute
  fingerprint: string
  status: 'pending' | 'completed' | 'failed'
  startedAt: string
  finishedAt?: string
  ownerPid: number
  result?: DispatchResult
  replayCommands?: Command[]
  error?: { code: string; message: string; pendingConfirmation: boolean }
}
export interface RequestClaim { key: string; record: RequestRecord; owned: boolean }

export function requestKey(command: Command, context: TrustedContext): string {
  return createHash('sha256').update(JSON.stringify([context.organizationId, context.requesterId, command.requestId])).digest('hex')
}

/** Local Ubuntu filesystem only. Existing pending records are never automatically reclaimed. */
export class FileRequestLedger {
  readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }

  async begin(command: Command, context: TrustedContext, route: CommandRoute, fingerprint: string): Promise<RequestClaim> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const key = requestKey(command, context)
    const directory = join(this.directory, key)
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let record: RequestRecord
      try { record = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')) as RequestRecord }
      catch { throw new DispatchError('REQUEST_IN_PROGRESS', '请求已占用或状态写入中；不得重复执行，请查询业务状态', true) }
      if (record.version !== 1 || !['pending', 'completed', 'failed'].includes(record.status)) {
        throw new DispatchError('REQUEST_STATE_UNAVAILABLE', '请求记录无法识别；请人工核查，不得自动重新执行', true)
      }
      if (record.fingerprint !== fingerprint) throw new DispatchError('REQUEST_CONFLICT', '相同 requestId 的内容、来源或执行配置已改变')
      return { key, record, owned: false }
    }
    const record: RequestRecord = {
      version: 1, requestId: command.requestId, organizationId: context.organizationId, requesterId: context.requesterId,
      source: context.source, route, fingerprint, status: 'pending', startedAt: new Date().toISOString(), ownerPid: process.pid,
      ...(command.kind === 'action' ? { operationId: command.operationId } : {}),
    }
    await this.write(key, record)
    // Persist directory creation before any downstream side effect.
    await this.syncDirectory(this.directory)
    return { key, record, owned: true }
  }

  async complete(claim: RequestClaim, result: DispatchResult, replayCommands: Command[] = []): Promise<void> {
    await this.write(claim.key, { ...claim.record, status: 'completed', finishedAt: new Date().toISOString(), result,
      ...(replayCommands.length ? { replayCommands } : {}) })
  }
  async fail(claim: RequestClaim, error: DispatchError): Promise<void> {
    await this.write(claim.key, { ...claim.record, status: 'failed', finishedAt: new Date().toISOString(),
      error: { code: error.code, message: error.message.slice(0, 2000), pendingConfirmation: error.pendingConfirmation } })
  }
  replay(claim: RequestClaim): DispatchResult {
    const { record } = claim
    if (record.status === 'completed' && record.result) return { ...record.result, replayed: true }
    if (record.status === 'failed' && record.error) {
      throw new DispatchError(record.error.code, record.error.message, record.error.pendingConfirmation)
    }
    throw new DispatchError('REQUEST_IN_PROGRESS', '请求尚未完成或执行进程已中断；请核查后续业务状态，不自动重试', true)
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  private async write(key: string, record: RequestRecord): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('请求记录路径无效')
    const directory = join(this.directory, key)
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, join(directory, 'record.json'))
      await this.syncDirectory(directory)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
  }
}
