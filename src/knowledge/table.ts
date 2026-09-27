import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type UntrustedKnowledgeContext } from './foundation.js'
import type { KnowledgeReadGate, SearchCandidate } from './query.js'
import type { SourceLocation } from './processing.js'

export interface TableCellEvidence extends SearchCandidate {
  rowKey: string
  value: string
  unit: string
}
export interface TableSumResult {
  value: string
  unit: string
  sources: Array<{ sourceRef: string; documentId: string; versionId: string; buildId: string;
    chunkId: string; rowKey: string; location: SourceLocation; originalText: string }>
}

const numeric = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/
function scaled(value: string): bigint {
  const match = value.match(numeric)
  if (!match) throw new KnowledgeError('TABLE_VALUE_INVALID', '表格单元格数值不符合受控计算范围')
  const magnitude = BigInt(match[2]) * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0'))
  return match[1] === '-' ? -magnitude : magnitude
}
function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ''}`
}

export async function calculateAuthorizedTableSum(context: UntrustedKnowledgeContext,
  identity: KnowledgeIdentityVerifier, gate: KnowledgeReadGate,
  input: { cells: TableCellEvidence[]; expectedRowKeys: string[]; unit: string }): Promise<TableSumResult> {
  const actor = await verifyKnowledgeActor(context, identity)
  if (!input.unit?.trim() || !Array.isArray(input.cells) || !Array.isArray(input.expectedRowKeys) ||
      !input.expectedRowKeys.length || input.expectedRowKeys.length > 10000 ||
      new Set(input.expectedRowKeys).size !== input.expectedRowKeys.length ||
      input.cells.length !== input.expectedRowKeys.length ||
      new Set(input.cells.map((cell) => cell.rowKey)).size !== input.cells.length ||
      input.cells.some((cell) => !input.expectedRowKeys.includes(cell.rowKey))) {
    throw new KnowledgeError('TABLE_COVERAGE_INCOMPLETE', '表格行清单不完整，不能计算合计')
  }
  const sources: TableSumResult['sources'] = []
  let total = 0n
  const snapshots = new Map<string, string>()
  for (const cell of input.cells) {
    if (cell.tenantId !== actor.tenantId) throw new KnowledgeError('ACCESS_DENIED', '表格单元格不可读取')
    if (cell.unit !== input.unit) throw new KnowledgeError('TABLE_UNIT_MISMATCH', '表格列单位不一致')
    if (cell.evidenceType !== 'table_cell' || cell.location.kind !== 'cell' || !cell.text?.trim() ||
        !cell.text.replace(/\s+/g, '').includes(`${cell.value}${cell.unit}`) ||
        cell.conflictStatus !== 'none') throw new KnowledgeError('TABLE_EVIDENCE_INVALID', '表格原始单元格证据无效')
    const snapshot = await gate.authorizeRead(context, { knowledgeBaseId: cell.knowledgeBaseId,
      documentId: cell.documentId, versionId: cell.versionId, buildId: cell.buildId, surface: 'original' })
    const snapshotKey = `${snapshot.releaseId}:${snapshot.epoch}:${snapshot.aclRevision}`
    if (snapshots.has(cell.knowledgeBaseId) && snapshots.get(cell.knowledgeBaseId) !== snapshotKey) {
      throw new KnowledgeError('TABLE_SNAPSHOT_CHANGED', '计算期间知识快照已改变')
    }
    snapshots.set(cell.knowledgeBaseId, snapshotKey)
    total += scaled(cell.value)
    sources.push({ sourceRef: `knowledge:${cell.documentId}:${cell.versionId}:${cell.buildId}:${cell.chunkId}`,
      documentId: cell.documentId, versionId: cell.versionId, buildId: cell.buildId,
      chunkId: cell.chunkId, rowKey: cell.rowKey, location: cell.location, originalText: cell.text })
  }
  return { value: decimal(total), unit: input.unit, sources }
}
