import { createHash } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeFoundation, type KnowledgeIdentityVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'
import { parseSegments, inspectArtifact, cleanArtifact, type ParserAdapter, type ParsedArtifact,
  type SourceSegment, type QualityIssue, type CleanResult } from './processing.js'
import { splitIntoChunks, type ChunkingResult, type SemanticBoundaryModel, type TokenCounter } from './chunking.js'
import { embedChunks, type EmbeddingCache, type EmbeddingProvider } from './embedding.js'
import type { StagedKnowledgeIndex } from './staged-index.js'

export interface OriginalSourceReader {
  read(objectRef: string): Promise<{ bytes: Uint8Array; mediaType: ParsedArtifact['mediaType'];
    expectedPages: number | null; segments: SourceSegment[] }>
}
export interface ProcessingArtifactStore {
  save(input: { versionId: string; buildId: string; generation: number;
    parsed: ParsedArtifact; cleaned: CleanResult; chunking: ChunkingResult | null;
    qualityIssues: QualityIssue[] }): Promise<string>
}
export interface ExternalModelDataPolicy {
  authorize(input: { tenantId: number; versionId: string; objectRef: string;
    mediaType: ParsedArtifact['mediaType']; operations: Array<'ocr' | 'semantic_split' | 'embedding'> }):
    Promise<'raw_allowed' | 'redaction_required' | 'blocked'>
}
export interface PipelineConfig {
  pipelineFingerprint: string
  minChildTokens: number
  maxChildTokens: number
  maxParentTokens: number
  modelIdentity: string
  dimensions: number
  maxBatchItems: number
  maxBatchTokens: number
  maxAttempts: number
}

export class KnowledgeProcessingPipeline {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly foundation: KnowledgeFoundation, private readonly stagedIndex: StagedKnowledgeIndex,
    private readonly source: OriginalSourceReader, private readonly parsers: { native: ParserAdapter; ocr: ParserAdapter },
    private readonly semanticModel: SemanticBoundaryModel, private readonly tokenCounter: TokenCounter,
    private readonly embeddingProvider: EmbeddingProvider, private readonly embeddingCache: EmbeddingCache,
    private readonly artifacts: ProcessingArtifactStore, private readonly modelDataPolicy: ExternalModelDataPolicy,
    private readonly config: PipelineConfig) {}

  private async record(context: UntrustedKnowledgeContext, run: { runId: string; buildId: string; generation: number },
    artifactRef: string, issues: QualityIssue[], status: 'review_required' | 'staged'): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    await this.database.transaction(async (tx) => {
      const build = (await tx.query<{ status: string; lease_generation: number }>(`SELECT status, lease_generation
        FROM hz_builds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, run.buildId])).rows[0]
      const current = (await tx.query<{ status: string; generation: number }>(`SELECT status, generation
        FROM hz_processing_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, run.runId])).rows[0]
      if (!build || !current || build.status !== 'processing' || current.status !== 'processing' ||
          Number(build.lease_generation) !== run.generation || Number(current.generation) !== run.generation) {
        throw new KnowledgeError('STALE_RUN', '旧任务不能保存处理产物')
      }
      await tx.query(`INSERT INTO hz_p2_processing_artifacts
        (tenant_id, build_id, generation, artifact_ref, quality_issues, status)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (tenant_id, build_id, generation) DO NOTHING`,
      [actor.tenantId, run.buildId, run.generation, artifactRef, JSON.stringify(issues), status])
      const saved = (await tx.query<{ artifact_ref: string; status: string }>(`SELECT artifact_ref, status
        FROM hz_p2_processing_artifacts WHERE tenant_id=$1 AND build_id=$2 AND generation=$3`,
      [actor.tenantId, run.buildId, run.generation])).rows[0]
      if (saved.artifact_ref !== artifactRef || saved.status !== status) {
        throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '同一任务代次已有不同处理产物')
      }
    })
  }

  async process(context: UntrustedKnowledgeContext, input: { versionId: string; idempotencyKey: string }): Promise<{
    status: 'ready' | 'review_required'; runId: string; buildId: string; artifactRef: string;
    qualityIssues: QualityIssue[]; chunkCount: number
  }> {
    const version = await this.foundation.getIngestVersion(context, input.versionId)
    const run = await this.foundation.startBuild(context, { versionId: input.versionId,
      pipelineFingerprint: this.config.pipelineFingerprint, idempotencyKey: input.idempotencyKey })
    if (!run.startedNow) {
      const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
      const prior = (await this.database.query<{ status: string; artifact_ref: string | null;
        chunk_count: number | null }>(`SELECT r.status, a.artifact_ref, m.chunk_count
        FROM hz_processing_runs r
        LEFT JOIN hz_p2_processing_artifacts a ON a.tenant_id=r.tenant_id
          AND a.build_id=r.build_id AND a.generation=r.generation
        LEFT JOIN hz_p2_index_manifests m ON m.tenant_id=r.tenant_id AND m.build_id=r.build_id
        WHERE r.tenant_id=$1 AND r.id=$2`, [actor.tenantId, run.runId])).rows[0]
      if (prior?.status === 'completed' && prior.artifact_ref &&
          await this.stagedIndex.verify({ tenantId: actor.tenantId, buildId: run.buildId,
            generation: run.generation })) {
        return { status: 'ready', runId: run.runId, buildId: run.buildId,
          artifactRef: prior.artifact_ref, qualityIssues: [], chunkCount: Number(prior.chunk_count) }
      }
      throw new KnowledgeError(prior?.status === 'processing' ? 'PROCESSING_IN_PROGRESS' : 'IDEMPOTENCY_CONFLICT',
        '该幂等键对应的任务已经存在，请查询原任务状态或使用新键重试')
    }
    try {
      const original = await this.source.read(version.objectRef)
      const actualHash = createHash('sha256').update(original.bytes).digest('hex')
      if (actualHash !== version.contentHash) throw new KnowledgeError('SOURCE_HASH_MISMATCH', '原件内容与登记版本不一致')
      const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
      const decision = await this.modelDataPolicy.authorize({ tenantId: actor.tenantId, versionId: version.versionId,
        objectRef: version.objectRef, mediaType: original.mediaType,
        operations: ['ocr', 'semantic_split', 'embedding'] })
      if (decision !== 'raw_allowed') {
        throw new KnowledgeError(decision === 'redaction_required' ? 'REDACTION_ADAPTER_REQUIRED' : 'MODEL_DATA_BLOCKED',
          '当前资料的模型处理策略不允许直接外发原文')
      }
      const parsed = await parseSegments({ documentId: version.documentId, versionId: version.versionId,
        buildId: run.buildId, mediaType: original.mediaType, expectedPages: original.expectedPages,
        segments: original.segments }, this.parsers)
      const qualityIssues = inspectArtifact(parsed)
      const cleaned = cleanArtifact(parsed)
      if (qualityIssues.length) {
        const artifactRef = await this.artifacts.save({ versionId: version.versionId, buildId: run.buildId,
          generation: run.generation, parsed, cleaned, chunking: null, qualityIssues })
        await this.record(context, run, artifactRef, qualityIssues, 'review_required')
        await this.foundation.failBuild(context, { runId: run.runId, generation: run.generation, reason: '解析质量需要人工复核' })
        return { status: 'review_required', runId: run.runId, buildId: run.buildId,
          artifactRef, qualityIssues, chunkCount: 0 }
      }
      const chunking = await splitIntoChunks({ buildId: run.buildId, blocks: cleaned.blocks,
        minChildTokens: this.config.minChildTokens, maxChildTokens: this.config.maxChildTokens,
        maxParentTokens: this.config.maxParentTokens, tokenCounter: this.tokenCounter,
        boundaryModel: this.semanticModel })
      const embedded = await embedChunks({ tenantId: actor.tenantId, chunks: chunking.chunks,
        modelIdentity: this.config.modelIdentity, dimensions: this.config.dimensions,
        maxBatchItems: this.config.maxBatchItems, maxBatchTokens: this.config.maxBatchTokens,
        maxAttempts: this.config.maxAttempts, provider: this.embeddingProvider, cache: this.embeddingCache })
      const artifactRef = await this.artifacts.save({ versionId: version.versionId, buildId: run.buildId,
        generation: run.generation, parsed, cleaned, chunking, qualityIssues })
      await this.stagedIndex.stage(context, { runId: run.runId, buildId: run.buildId,
        generation: run.generation, modelIdentity: this.config.modelIdentity, dimensions: this.config.dimensions,
        chunks: embedded, parents: chunking.parents })
      await this.record(context, run, artifactRef, qualityIssues, 'staged')
      await this.foundation.completeBuild(context, { runId: run.runId, generation: run.generation })
      return { status: 'ready', runId: run.runId, buildId: run.buildId,
        artifactRef, qualityIssues, chunkCount: chunking.chunks.length }
    } catch (error) {
      try {
        await this.foundation.failBuild(context, { runId: run.runId, generation: run.generation,
          reason: error instanceof KnowledgeError ? error.code : 'PROCESSING_FAILED' })
      } catch { /* 旧代次或已完成的任务不能再改变状态 */ }
      throw error
    }
  }
}
