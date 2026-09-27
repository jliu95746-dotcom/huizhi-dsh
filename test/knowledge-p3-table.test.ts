import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateAuthorizedTableSum, type TableCellEvidence } from '../src/knowledge/table.js'
import type { KnowledgeIdentityVerifier, UntrustedKnowledgeContext } from '../src/knowledge/foundation.js'

const context: UntrustedKnowledgeContext = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'alice' }
const identity: KnowledgeIdentityVerifier = { verify: async () => ({ tenantId: 7, organizationId: 'org', requesterId: 'alice',
  principals: [{ type: 'user', id: 'alice' }], permissions: [] }) }
const cell = (rowKey: string, value: string, unit = '元'): TableCellEvidence => ({
  tenantId: 7, knowledgeBaseId: 'kb', documentId: 'doc', versionId: 'v1', buildId: 'build',
  chunkId: `cell-${rowKey}`, title: '预算表', text: `${rowKey} ${value}${unit}`,
  location: { kind: 'cell', sheet: 'Sheet1', range: `B${rowKey}` }, evidenceType: 'table_cell',
  conflictStatus: 'none', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, score: 1,
  rowKey, value, unit,
})

test('表格合计使用完整行清单和精确小数，保留原始单元格来源', async () => {
  const result = await calculateAuthorizedTableSum(context, identity, { authorizeRead: async () =>
    ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) }, { cells: [cell('2', '0.1'), cell('3', '0.2')],
    expectedRowKeys: ['2', '3'], unit: '元' })
  assert.equal(result.value, '0.3')
  assert.equal(result.sources.length, 2)
  assert.deepEqual(result.sources[0].location, { kind: 'cell', sheet: 'Sheet1', range: 'B2' })
})

test('表格合计拒绝缺行、混单位和无权单元格', async () => {
  const gate = { authorizeRead: async (_context: UntrustedKnowledgeContext, input: { documentId: string }) => {
    if (input.documentId === 'secret') throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' })
    return { releaseId: 'release', epoch: 1, aclRevision: 1 }
  } }
  const input = { cells: [cell('2', '1')], expectedRowKeys: ['2', '3'], unit: '元' }
  await assert.rejects(calculateAuthorizedTableSum(context, identity, gate, input), { code: 'TABLE_COVERAGE_INCOMPLETE' })
  await assert.rejects(calculateAuthorizedTableSum(context, identity, gate, { cells: [cell('2', '1'), cell('3', '2', '万元')],
    expectedRowKeys: ['2', '3'], unit: '元' }), { code: 'TABLE_UNIT_MISMATCH' })
  await assert.rejects(calculateAuthorizedTableSum(context, identity, gate, { cells: [{ ...cell('2', '1'), documentId: 'secret' }],
    expectedRowKeys: ['2'], unit: '元' }), { code: 'ACCESS_DENIED' })
})
