import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { StagedKnowledgeIndex, type IndexReceipt, type PreSplitIndexSink } from '../src/knowledge/staged-index.js'

const owner: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'owner',
  principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish', 'manage_acl'] }
const identity = { verify: async () => owner }
const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'owner' }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture(t: TestContext, receiptOverride: Partial<IndexReceipt> = {}) {
  const database = await PGlite.create()
  t.after(async () => database.close())
  for (const migration of ['0001_p1_foundation.up.sql', '0002_p2_staged_index.up.sql']) {
    await database.exec(await readFile(resolve('plugins/knowledge/migrations', migration), 'utf8'))
  }
  const sql: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
      ({ rows: (await database.query<Row>(query, params)).rows }),
    transaction: (work) => database.transaction(async (tx) => work({
      query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
        ({ rows: (await tx.query<Row>(query, params)).rows }),
    })),
  }
  let stagedReceipt: IndexReceipt | null = null
  let sinkCalls = 0
  const sink: PreSplitIndexSink = {
    stage: async (input) => {
      sinkCalls++
      assert.equal(input.mode, 'presplit')
      stagedReceipt = { receiptRef: `receipt-${sinkCalls}`, indexedChunkIds: input.chunks.map((item) => item.chunk.id),
        indexedParentIds: input.parents.map((parent) => parent.id),
        modes: ['keyword', 'vector'], splitterInvoked: false, modelIdentity: input.modelIdentity,
        dimensions: input.dimensions, ...receiptOverride }
      return stagedReceipt
    },
    verify: async () => stagedReceipt!,
  }
  const staged = new StagedKnowledgeIndex(sql, identity, sink)
  const foundation = new KnowledgeFoundation(sql, identity, staged, () => new Date('2026-09-27T12:00:00Z'))
  const version = await foundation.registerVersion(context, { knowledgeBaseId: 'kb', sourceSystem: 'test',
    sourceDocumentId: 'policy', sourceRevision: 'r1', contentHash: 'a'.repeat(64), objectRef: 'private://source' })
  const run = await foundation.startBuild(context, { versionId: version.versionId,
    pipelineFingerprint: 'p2-v1', idempotencyKey: 'first-run' })
  const embedded = [{ chunk: { id: 'b'.repeat(64), parentId: 'c'.repeat(64), text: '第一条 不得超过500元',
    blockIds: ['block-1'], locations: [{ kind: 'page' as const, pageNumber: 1 }], tokenCount: 8 },
    vector: [0.2, 0.3], contentHash: sha('第一条 不得超过500元') }]
  const parents = [{ id: 'c'.repeat(64), childIds: ['b'.repeat(64)], text: '第一条 不得超过500元', tokenCount: 8 }]
  return { database, foundation, staged, version, run, embedded, parents, sinkCalls: () => sinkCalls }
}

test('预切分双路索引回执及清单核对后，P1 才能把构建标为就绪', async (t) => {
  const { database, foundation, staged, version, run, embedded, parents, sinkCalls } = await fixture(t)
  await assert.rejects(foundation.completeBuild(context, { runId: run.runId, generation: run.generation }),
    { code: 'INDEX_NOT_VERIFIED' })
  await staged.stage(context, { runId: run.runId, buildId: run.buildId, generation: run.generation,
    modelIdentity: 'embedding-v1', dimensions: 2, chunks: embedded, parents })
  const changed = embedded.map((item) => ({ ...item, chunk: { ...item.chunk, text: '不同的条款' },
    contentHash: sha('不同的条款') }))
  const changedParents = parents.map((parent) => ({ ...parent, text: '不同的条款' }))
  await assert.rejects(staged.stage(context, { runId: run.runId, buildId: run.buildId,
    generation: run.generation, modelIdentity: 'embedding-v1', dimensions: 2, chunks: changed,
    parents: changedParents }),
  { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal(sinkCalls(), 1)
  assert.equal(await staged.verify({ tenantId: 7, buildId: run.buildId, generation: run.generation }), true)
  await foundation.completeBuild(context, { runId: run.runId, generation: run.generation })
  await foundation.publish(context, { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'publish-p2', entries: [{ ...version, buildId: run.buildId,
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }] })
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_p2_index_entries')).rows[0].count, 1)
  await database.query('DELETE FROM hz_p2_index_entries WHERE tenant_id=$1 AND build_id=$2', [7, run.buildId])
  assert.equal(await staged.verify({ tenantId: 7, buildId: run.buildId, generation: run.generation }), false)
})

test('索引回执显示再次切分或旧任务回调时，拒绝暂存与发布', async (t) => {
  const { foundation, staged, run, embedded, parents, sinkCalls } = await fixture(t, { splitterInvoked: true })
  await assert.rejects(staged.stage(context, { runId: run.runId, buildId: run.buildId,
    generation: run.generation, modelIdentity: 'embedding-v1', dimensions: 2, chunks: embedded, parents }),
  { code: 'INDEX_RECEIPT_INVALID' })
  const second = await foundation.startBuild(context, { versionId: (await foundation.registerVersion(context,
    { knowledgeBaseId: 'kb', sourceSystem: 'test', sourceDocumentId: 'policy', sourceRevision: 'r1',
      contentHash: 'a'.repeat(64), objectRef: 'private://source' })).versionId,
  pipelineFingerprint: 'p2-v1', idempotencyKey: 'second-run' })
  await assert.rejects(staged.stage(context, { runId: run.runId, buildId: run.buildId,
    generation: run.generation, modelIdentity: 'embedding-v1', dimensions: 2, chunks: embedded, parents }),
  { code: 'STALE_RUN' })
  assert.equal(sinkCalls(), 1)
  await assert.rejects(foundation.completeBuild(context, { runId: second.runId, generation: second.generation }),
    { code: 'INDEX_NOT_VERIFIED' })
})

test('父片段正文或索引回执缺失时不能通过完整性校验', async (t) => {
  const { staged, run, embedded, parents, sinkCalls } = await fixture(t, { indexedParentIds: [] })
  await assert.rejects(staged.stage(context, { runId: run.runId, buildId: run.buildId,
    generation: run.generation, modelIdentity: 'embedding-v1', dimensions: 2, chunks: embedded,
    parents: [{ ...parents[0], text: '与子片段不一致' }] }), { code: 'INDEX_INPUT_INVALID' })
  assert.equal(sinkCalls(), 0)
  await assert.rejects(staged.stage(context, { runId: run.runId, buildId: run.buildId,
    generation: run.generation, modelIdentity: 'embedding-v1', dimensions: 2, chunks: embedded, parents }),
  { code: 'INDEX_RECEIPT_INVALID' })
})

test('P2 暂存索引迁移可回退，保留 P1 数据', async (t) => {
  const { database } = await fixture(t)
  await database.exec(await readFile(resolve('plugins/knowledge/migrations/0002_p2_staged_index.down.sql'), 'utf8'))
  const tables = (await database.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname='public' AND tablename LIKE 'hz_p2_%'`)).rows
  assert.deepEqual(tables, [])
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_builds')).rows[0].count, 1)
})
