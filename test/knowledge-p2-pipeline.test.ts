import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeProcessingPipeline } from '../src/knowledge/pipeline.js'
import { StagedKnowledgeIndex, type IndexReceipt } from '../src/knowledge/staged-index.js'
import type { ParsedSegment } from '../src/knowledge/processing.js'

const context = { serviceCredential: 'trusted', organizationId: 'org', requesterId: 'owner' }
const actor: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'owner',
  principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish'] }
const identity = { verify: async () => actor }
const bytes = Buffer.from('synthetic original PDF bytes')
const hash = createHash('sha256').update(bytes).digest('hex')

async function fixture(t: TestContext, options: { failedOcr?: boolean; wrongBytes?: boolean;
  policy?: 'raw_allowed' | 'redaction_required' | 'blocked' } = {}) {
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
  let receipt: IndexReceipt | null = null
  const staged = new StagedKnowledgeIndex(sql, identity, {
    stage: async (input) => {
      receipt = { receiptRef: 'receipt-1', indexedChunkIds: input.chunks.map((chunk) => chunk.chunk.id),
        indexedParentIds: input.parents.map((parent) => parent.id),
        modes: ['keyword', 'vector'], splitterInvoked: false, modelIdentity: input.modelIdentity,
        dimensions: input.dimensions }
      return receipt
    },
    verify: async () => receipt!,
  })
  const foundation = new KnowledgeFoundation(sql, identity, staged, () => new Date('2026-09-27T12:00:00Z'))
  const version = await foundation.registerVersion(context, { knowledgeBaseId: 'kb', sourceSystem: 'test',
    sourceDocumentId: 'policy', sourceRevision: 'r1', contentHash: hash, objectRef: 'private://original' })
  const parsedPage = (source: { sequence: number; sourceRef: string }, failed = false): ParsedSegment => ({
    sequence: source.sequence, status: failed ? 'failed' : 'ok', parserName: failed ? 'ocr-api' : 'native',
    parserVersion: '1', modelIdentity: failed ? 'ocr-v1' : null, originalRef: source.sourceRef,
    blocks: failed ? [] : [{ id: 'clause-1', type: 'clause', text: '不得 超过 500 元', sequence: 1,
      location: { kind: 'page', pageNumber: 1 }, headingPath: ['第一条'], sourceSpans: [{ start: 0, end: 12 }] }],
    tables: [],
  })
  let savedPreview = false
  const embeddingTexts: string[] = []
  const pipeline = new KnowledgeProcessingPipeline(sql, identity, foundation, staged, {
    read: async () => ({ bytes: options.wrongBytes ? Buffer.from('changed') : bytes, mediaType: 'pdf',
      expectedPages: 1, segments: [{ sequence: 1, route: options.failedOcr ? 'ocr' : 'native',
        location: { kind: 'page', pageNumber: 1 }, sourceRef: 'private://page-1' }] }),
  }, { native: { parse: async (source) => parsedPage(source) },
    ocr: { parse: async (source) => parsedPage(source, options.failedOcr) } },
  { propose: async () => ({ beforeBlockIds: [], modelIdentity: 'semantic-v1' }) },
  { count: (text) => text.split(/\s+/u).filter(Boolean).length },
  { embed: async ({ items, modelIdentity }) => {
    embeddingTexts.push(...items.map((item) => item.text))
    return { modelIdentity, vectors: items.map((item) => ({ id: item.id, values: [0.1, 0.2] })) }
  } },
  { get: async () => null, put: async () => undefined },
  { save: async ({ parsed, cleaned }) => { savedPreview = parsed.blocks.length >= cleaned.blocks.length; return 'private://preview' } },
  { authorize: async () => options.policy ?? 'raw_allowed' },
  { pipelineFingerprint: 'p2-v1', minChildTokens: 1, maxChildTokens: 20, maxParentTokens: 40,
    modelIdentity: 'embedding-v1', dimensions: 2, maxBatchItems: 4, maxBatchTokens: 20, maxAttempts: 2 })
  return { database, pipeline, version, previewSaved: () => savedPreview, embeddingTexts }
}

test('入库流水线核验原件哈希、暂存预切分索引并留预览，不自动发布', async (t) => {
  const { database, pipeline, version, previewSaved, embeddingTexts } = await fixture(t)
  const result = await pipeline.process(context, { versionId: version.versionId, idempotencyKey: 'p2-ready' })
  assert.equal(result.status, 'ready')
  assert.equal(result.chunkCount, 1)
  assert.deepEqual(await pipeline.process(context, { versionId: version.versionId, idempotencyKey: 'p2-ready' }), result)
  assert.equal(previewSaved(), true)
  assert.deepEqual(embeddingTexts, ['不得 超过 500 元'])
  assert.equal((await database.query<{ status: string }>('SELECT status FROM hz_builds WHERE id=$1', [result.buildId])).rows[0].status, 'ready')
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_releases')).rows[0].count, 0)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_processing_runs')).rows[0].count, 1)
  assert.equal((await database.query<{ status: string }>('SELECT status FROM hz_p2_processing_artifacts WHERE build_id=$1',
    [result.buildId])).rows[0].status, 'staged')
})

test('OCR 失败进入待复核记录且不会写索引或发布', async (t) => {
  const { database, pipeline, version } = await fixture(t, { failedOcr: true })
  const result = await pipeline.process(context, { versionId: version.versionId, idempotencyKey: 'p2-review' })
  assert.equal(result.status, 'review_required')
  assert.ok(result.qualityIssues.some((issue) => issue.code === 'PARSE_FAILED'))
  assert.equal((await database.query<{ status: string }>('SELECT status FROM hz_builds WHERE id=$1', [result.buildId])).rows[0].status, 'failed')
  assert.equal((await database.query<{ status: string }>('SELECT status FROM hz_p2_processing_artifacts WHERE build_id=$1',
    [result.buildId])).rows[0].status, 'review_required')
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_p2_index_manifests')).rows[0].count, 0)
})

test('原件哈希不符直接失败，不调用模型或生成暂存索引', async (t) => {
  const { database, pipeline, version } = await fixture(t, { wrongBytes: true })
  await assert.rejects(pipeline.process(context, { versionId: version.versionId, idempotencyKey: 'p2-bad-source' }),
    { code: 'SOURCE_HASH_MISMATCH' })
  assert.equal((await database.query<{ status: string }>('SELECT status FROM hz_builds')).rows[0].status, 'failed')
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_p2_index_manifests')).rows[0].count, 0)
})

test('外发策略拒绝时不调用 OCR/Embedding；明确无需脱敏时保持原文', async (t) => {
  const { database, pipeline, version, previewSaved } = await fixture(t, { policy: 'blocked' })
  await assert.rejects(pipeline.process(context, { versionId: version.versionId, idempotencyKey: 'p2-policy' }),
    { code: 'MODEL_DATA_BLOCKED' })
  assert.equal(previewSaved(), false)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_p2_index_manifests')).rows[0].count, 0)
  const requiresRedaction = await fixture(t, { policy: 'redaction_required' })
  await assert.rejects(requiresRedaction.pipeline.process(context, {
    versionId: requiresRedaction.version.versionId, idempotencyKey: 'p2-redaction',
  }), { code: 'REDACTION_ADAPTER_REQUIRED' })
})
