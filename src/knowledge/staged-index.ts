import { createHash } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier, type KnowledgeIndexVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'
import type { EmbeddedChunk } from './embedding.js'
import type { ParentChunk } from './chunking.js'

export interface IndexReceipt {
  receiptRef: string
  indexedChunkIds: string[]
  indexedParentIds: string[]
  modes: Array<'keyword' | 'vector'>
  splitterInvoked: boolean
  modelIdentity: string
  dimensions: number
}
export interface PreSplitIndexSink {
  stage(input: {
    tenantId: number; knowledgeBaseId: string; documentId: string; versionId: string;
    buildId: string; generation: number; mode: 'presplit'; modelIdentity: string; dimensions: number;
    chunks: EmbeddedChunk[]; parents: ParentChunk[]
  }): Promise<IndexReceipt>
  verify(input: { receiptRef: string; buildId: string; generation: number }): Promise<IndexReceipt>
}

type StageEntry = { chunkId: string; parentId: string; contentHash: string; vectorHash: string;
  keywordHash: string; sourceLocations: object[] }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const digest = (entries: StageEntry[]) => sha256(JSON.stringify(entries.map((entry) =>
  [entry.chunkId, entry.parentId, entry.contentHash, entry.vectorHash, entry.keywordHash]).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])))))
const validReceipt = (receipt: IndexReceipt, ids: string[], parentIds: string[],
  modelIdentity: string, dimensions: number) =>
  !!receipt && typeof receipt.receiptRef === 'string' && receipt.receiptRef.length > 0 &&
  receipt.splitterInvoked === false && Array.isArray(receipt.modes) &&
  receipt.modes.includes('keyword') && receipt.modes.includes('vector') &&
  receipt.modelIdentity === modelIdentity && receipt.dimensions === dimensions &&
  Array.isArray(receipt.indexedChunkIds) && receipt.indexedChunkIds.length === ids.length &&
  JSON.stringify([...receipt.indexedChunkIds].sort()) === JSON.stringify([...ids].sort()) &&
  Array.isArray(receipt.indexedParentIds) && receipt.indexedParentIds.length === parentIds.length &&
  JSON.stringify([...receipt.indexedParentIds].sort()) === JSON.stringify([...parentIds].sort())

export class StagedKnowledgeIndex implements KnowledgeIndexVerifier {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly sink: PreSplitIndexSink) {}

  async stage(context: UntrustedKnowledgeContext, input: {
    runId: string; buildId: string; generation: number; modelIdentity: string; dimensions: number;
    chunks: EmbeddedChunk[]; parents: ParentChunk[]
  }): Promise<{ manifestHash: string; receiptRef: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    if (!input.runId || !input.buildId || !input.modelIdentity || !Number.isSafeInteger(input.generation) ||
        input.generation < 1 || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 ||
        !input.chunks.length || !input.parents.length ||
        new Set(input.chunks.map((item) => item.chunk.id)).size !== input.chunks.length ||
        new Set(input.parents.map((item) => item.id)).size !== input.parents.length) {
      throw new KnowledgeError('INVALID_INPUT', '暂存索引输入无效')
    }
    const byParent = new Map(input.parents.map((parent) => [parent.id, parent]))
    if (input.chunks.some((item) => !byParent.has(item.chunk.parentId)) ||
        input.parents.some((parent) => {
          const children = input.chunks.filter((item) => item.chunk.parentId === parent.id).map((item) => item.chunk)
          return !children.length || JSON.stringify(children.map((child) => child.id)) !== JSON.stringify(parent.childIds) ||
            children.map((child) => child.text).join('\n') !== parent.text
        })) throw new KnowledgeError('INDEX_INPUT_INVALID', '父子片段正文或引用关系不一致')
    const entries: StageEntry[] = input.chunks.map(({ chunk, vector, contentHash }) => {
      if (!/^[a-f0-9]{64}$/.test(chunk.id) || !/^[a-f0-9]{64}$/.test(chunk.parentId) ||
          contentHash !== sha256(chunk.text) || vector.length !== input.dimensions ||
          vector.some((value) => !Number.isFinite(value)) || !chunk.locations.length || !chunk.blockIds.length) {
        throw new KnowledgeError('INDEX_INPUT_INVALID', '片段 ID、来源或向量无效')
      }
      return { chunkId: chunk.id, parentId: chunk.parentId, contentHash,
        vectorHash: sha256(JSON.stringify(vector)), keywordHash: sha256(chunk.text), sourceLocations: chunk.locations }
    })
    const build = (await this.database.query<{ knowledge_base_id: string; document_id: string; version_id: string;
      lease_generation: number; status: string; run_status: string; run_generation: number }>(`
      SELECT d.knowledge_base_id, d.id AS document_id, b.version_id, b.lease_generation, b.status,
        r.status AS run_status, r.generation AS run_generation
      FROM hz_builds b JOIN hz_document_versions v ON v.tenant_id=b.tenant_id AND v.id=b.version_id
      JOIN hz_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
      JOIN hz_processing_runs r ON r.tenant_id=b.tenant_id AND r.build_id=b.id
      WHERE b.tenant_id=$1 AND b.id=$2 AND r.id=$3`,
    [actor.tenantId, input.buildId, input.runId])).rows[0]
    if (!build || build.status !== 'processing' || build.run_status !== 'processing' ||
        Number(build.lease_generation) !== input.generation || Number(build.run_generation) !== input.generation) {
      throw new KnowledgeError('STALE_RUN', '旧任务不能写入暂存索引')
    }
    const manifestHash = digest(entries)
    const prior = (await this.database.query<{ generation: number; manifest_hash: string }>(`
      SELECT generation, manifest_hash FROM hz_p2_index_manifests WHERE tenant_id=$1 AND build_id=$2`,
    [actor.tenantId, input.buildId])).rows[0]
    if (prior && Number(prior.generation) === input.generation && prior.manifest_hash !== manifestHash) {
      throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '同一任务代次不能改写暂存清单')
    }
    const receipt = await this.sink.stage({ tenantId: actor.tenantId,
      knowledgeBaseId: build.knowledge_base_id, documentId: build.document_id, versionId: build.version_id,
      buildId: input.buildId, generation: input.generation, mode: 'presplit', modelIdentity: input.modelIdentity,
      dimensions: input.dimensions,
      chunks: input.chunks, parents: input.parents })
    const ids = entries.map((entry) => entry.chunkId)
    const parentIds = input.parents.map((parent) => parent.id)
    if (!validReceipt(receipt, ids, parentIds, input.modelIdentity, input.dimensions)) {
      throw new KnowledgeError('INDEX_RECEIPT_INVALID', '索引未确认预切分片段及双路索引')
    }
    await this.database.transaction(async (tx) => {
      const locked = (await tx.query<{ lease_generation: number; status: string }>(`SELECT lease_generation, status
        FROM hz_builds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, input.buildId])).rows[0]
      const run = (await tx.query<{ generation: number; status: string }>(`SELECT generation, status
        FROM hz_processing_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, input.runId])).rows[0]
      if (!locked || !run || locked.status !== 'processing' || run.status !== 'processing' ||
          Number(locked.lease_generation) !== input.generation || Number(run.generation) !== input.generation) {
        throw new KnowledgeError('STALE_RUN', '索引返回时任务已过期')
      }
      const existing = (await tx.query<{ generation: number; manifest_hash: string }>(`
        SELECT generation, manifest_hash FROM hz_p2_index_manifests
        WHERE tenant_id=$1 AND build_id=$2 FOR UPDATE`, [actor.tenantId, input.buildId])).rows[0]
      if (existing && Number(existing.generation) === input.generation && existing.manifest_hash !== manifestHash) {
        throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '同一任务代次不能改写暂存清单')
      }
      await tx.query(`INSERT INTO hz_p2_index_manifests
        (tenant_id, build_id, generation, knowledge_base_id, document_id, version_id, model_identity,
         dimensions, chunk_count, parent_ids, manifest_hash, receipt_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        ON CONFLICT (tenant_id, build_id) DO UPDATE SET generation=$3, model_identity=$7, dimensions=$8,
          chunk_count=$9, parent_ids=$10::jsonb, manifest_hash=$11, receipt_ref=$12, staged_at=CURRENT_TIMESTAMP`,
      [actor.tenantId, input.buildId, input.generation, build.knowledge_base_id, build.document_id,
        build.version_id, input.modelIdentity, input.dimensions, entries.length, JSON.stringify(parentIds),
        manifestHash, receipt.receiptRef])
      await tx.query(`DELETE FROM hz_p2_index_entries WHERE tenant_id=$1 AND build_id=$2`, [actor.tenantId, input.buildId])
      for (const entry of entries) {
        await tx.query(`INSERT INTO hz_p2_index_entries
          (tenant_id, build_id, chunk_id, parent_id, content_hash, vector_hash, keyword_hash, source_locations)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [actor.tenantId, input.buildId, entry.chunkId, entry.parentId, entry.contentHash,
          entry.vectorHash, entry.keywordHash, JSON.stringify(entry.sourceLocations)])
      }
    })
    return { manifestHash, receiptRef: receipt.receiptRef }
  }

  async verify(input: { tenantId: number; buildId: string; generation: number }): Promise<boolean> {
    const manifest = (await this.database.query<{ generation: number; chunk_count: number; manifest_hash: string;
      receipt_ref: string; model_identity: string; dimensions: number; parent_ids: string[] }>(`
      SELECT generation, chunk_count, manifest_hash, receipt_ref, model_identity, dimensions, parent_ids
      FROM hz_p2_index_manifests WHERE tenant_id=$1 AND build_id=$2`, [input.tenantId, input.buildId])).rows[0]
    if (!manifest || Number(manifest.generation) !== input.generation) return false
    const rows = (await this.database.query<{ chunk_id: string; parent_id: string; content_hash: string;
      vector_hash: string; keyword_hash: string; source_locations: object[] }>(`
      SELECT chunk_id, parent_id, content_hash, vector_hash, keyword_hash, source_locations
      FROM hz_p2_index_entries WHERE tenant_id=$1 AND build_id=$2`, [input.tenantId, input.buildId])).rows
    if (rows.length !== Number(manifest.chunk_count) || rows.some((row) => !Array.isArray(row.source_locations) ||
        !row.source_locations.length)) return false
    const entries = rows.map((row) => ({ chunkId: row.chunk_id, parentId: row.parent_id,
      contentHash: row.content_hash, vectorHash: row.vector_hash, keywordHash: row.keyword_hash,
      sourceLocations: row.source_locations }))
    if (digest(entries) !== manifest.manifest_hash) return false
    try {
      const receipt = await this.sink.verify({ receiptRef: manifest.receipt_ref, buildId: input.buildId,
        generation: input.generation })
      return receipt.receiptRef === manifest.receipt_ref && validReceipt(receipt,
        rows.map((row) => row.chunk_id), manifest.parent_ids, manifest.model_identity, Number(manifest.dimensions))
    } catch {
      return false
    }
  }
}
