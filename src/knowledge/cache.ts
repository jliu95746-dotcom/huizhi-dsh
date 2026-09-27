import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'
import type { KnowledgeSearchResult } from './query.js'

export interface CacheSnapshot { releaseId: string | null; epoch: number; aclRevision: number;
  nextBoundary: string | null }
export interface CacheSnapshotProvider {
  current(context: UntrustedKnowledgeContext, knowledgeBaseId: string): Promise<CacheSnapshot>
}
export interface CacheReadGate {
  authorizeRead(context: UntrustedKnowledgeContext, source: { knowledgeBaseId: string;
    documentId: string; versionId: string; buildId: string; surface: 'search' }): Promise<{
      releaseId: string; epoch: number; aclRevision: number }>
}
export interface FaqApprovalGate {
  isApprovedAndReadable(context: UntrustedKnowledgeContext, knowledgeBaseId: string,
    assetId: string): Promise<boolean>
}
export interface DerivedReadGate {
  authorizeDerivedRead(context: UntrustedKnowledgeContext, assetId: string): Promise<{
    objectRef: string; kind: string; sourceRefs: string[] }>
}
export interface KnowledgeCacheStore {
  get(key: string): Promise<{ value: unknown; expiresAt: number } | null>
  set(key: string, value: unknown, expiresAt: number): Promise<void>
  delete(key: string): Promise<void>
}

export class InMemoryKnowledgeCacheStore implements KnowledgeCacheStore {
  private readonly items = new Map<string, { value: unknown; expiresAt: number }>()
  async get(key: string) { return this.items.get(key) ?? null }
  async set(key: string, value: unknown, expiresAt: number) { this.items.set(key, { value: structuredClone(value), expiresAt }) }
  async delete(key: string) { this.items.delete(key) }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validText = (value: string, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 无效`)
  }
  return value.trim()
}
const sameSnapshot = (left: CacheSnapshot, right: { releaseId: string; epoch: number; aclRevision: number }) =>
  left.releaseId === right.releaseId && left.epoch === right.epoch && left.aclRevision === right.aclRevision

export class KnowledgeSearchCache {
  constructor(private readonly store: KnowledgeCacheStore, private readonly identity: KnowledgeIdentityVerifier,
    private readonly snapshots: CacheSnapshotProvider, private readonly readGate: CacheReadGate,
    private readonly now: () => Date = () => new Date()) {}

  private async scoped(context: UntrustedKnowledgeContext, knowledgeBaseId: string, question: string,
    configFingerprint: string) {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const kb = validText(knowledgeBaseId, 'knowledgeBaseId', 36)
    const query = validText(question, 'question', 4000)
    const config = validText(configFingerprint, 'configFingerprint', 256)
    const snapshot = await this.snapshots.current(context, kb)
    const key = digest([actor.tenantId, actor.requesterId, kb, query, config,
      snapshot.releaseId, snapshot.epoch, snapshot.aclRevision])
    return { kb, snapshot, key }
  }

  private expiry(snapshot: CacheSnapshot, maxSeconds: number, effectiveTo: Array<string | null> = []): number {
    const now = this.now().getTime()
    const boundaries = [snapshot.nextBoundary, ...effectiveTo].filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))
    return Math.min(now + maxSeconds * 1000, ...boundaries)
  }

  private async verifyHits(context: UntrustedKnowledgeContext, kb: string,
    snapshot: CacheSnapshot, result: KnowledgeSearchResult): Promise<boolean> {
    if (result.status === 'no_evidence') return result.hits.length === 0
    if (result.status !== 'ok' || !result.hits.length || result.hits.length > 8) return false
    for (const hit of result.hits) {
      if (hit.knowledgeBaseId !== kb || hit.evidenceType === 'generated_summary' ||
        hit.sourceRef !== `knowledge:${hit.documentId}:${hit.version}:${hit.buildId}:${hit.chunkId}`) return false
      try {
        const current = await this.readGate.authorizeRead(context, { knowledgeBaseId: kb,
          documentId: hit.documentId, versionId: hit.version, buildId: hit.buildId, surface: 'search' })
        if (!sameSnapshot(snapshot, current)) return false
      } catch { return false }
    }
    return true
  }

  async put(context: UntrustedKnowledgeContext, knowledgeBaseId: string, question: string,
    configFingerprint: string, result: KnowledgeSearchResult): Promise<void> {
    const { kb, snapshot, key } = await this.scoped(context, knowledgeBaseId, question, configFingerprint)
    if (!await this.verifyHits(context, kb, snapshot, result)) return
    const expiresAt = this.expiry(snapshot, result.status === 'no_evidence' ? 10 : 60,
      result.hits.map((hit) => hit.effectiveTo))
    if (expiresAt <= this.now().getTime()) return
    await this.store.set(`search:${key}`, result, expiresAt)
  }

  async get(context: UntrustedKnowledgeContext, knowledgeBaseId: string, question: string,
    configFingerprint: string): Promise<KnowledgeSearchResult | null> {
    const { kb, snapshot, key } = await this.scoped(context, knowledgeBaseId, question, configFingerprint)
    const saved = await this.store.get(`search:${key}`)
    if (!saved) return null
    if (saved.expiresAt <= this.now().getTime() || !await this.verifyHits(context, kb, snapshot,
      saved.value as KnowledgeSearchResult)) {
      await this.store.delete(`search:${key}`)
      return null
    }
    const latest = await this.snapshots.current(context, kb)
    if (latest.releaseId !== snapshot.releaseId || latest.epoch !== snapshot.epoch ||
      latest.aclRevision !== snapshot.aclRevision) return null
    const result = structuredClone(saved.value as KnowledgeSearchResult)
    result.traceId = context.taskId || randomUUID()
    result.sourceRef = `knowledge-query:${digest([result.traceId, result.version,
      result.hits.map((hit) => hit.sourceRef)])}`
    return result
  }

  async putFaqAnswer(context: UntrustedKnowledgeContext, knowledgeBaseId: string, assetId: string,
    question: string, answer: string, approval: FaqApprovalGate): Promise<void> {
    const { kb, snapshot, key } = await this.scoped(context, knowledgeBaseId, question, assetId)
    validText(answer, 'answer', 12000)
    if (!await approval.isApprovedAndReadable(context, kb, assetId)) {
      throw new KnowledgeError('FAQ_NOT_APPROVED', 'FAQ 未审核或来源已失效')
    }
    const expiresAt = this.expiry(snapshot, 60)
    if (expiresAt > this.now().getTime()) await this.store.set(`faq:${key}`, answer, expiresAt)
  }

  async getFaqAnswer(context: UntrustedKnowledgeContext, knowledgeBaseId: string, assetId: string,
    question: string, approval: FaqApprovalGate): Promise<string | null> {
    const { kb, key } = await this.scoped(context, knowledgeBaseId, question, assetId)
    const saved = await this.store.get(`faq:${key}`)
    if (!saved) return null
    if (saved.expiresAt <= this.now().getTime() ||
      !await approval.isApprovedAndReadable(context, kb, assetId)) {
      await this.store.delete(`faq:${key}`)
      return null
    }
    return typeof saved.value === 'string' ? saved.value : null
  }
}

export class CachedKnowledgeSearch {
  constructor(private readonly searcher: { search(context: UntrustedKnowledgeContext,
    question: string): Promise<KnowledgeSearchResult> }, private readonly cache: KnowledgeSearchCache,
    private readonly knowledgeBaseId: string, private readonly configFingerprint: string) {}

  async search(context: UntrustedKnowledgeContext, question: string): Promise<KnowledgeSearchResult> {
    const cached = await this.cache.get(context, this.knowledgeBaseId, question, this.configFingerprint)
    if (cached) return cached
    const result = await this.searcher.search(context, question)
    await this.cache.put(context, this.knowledgeBaseId, question, this.configFingerprint, result)
    return result
  }
}

export class PostgresKnowledgeCacheSnapshot implements CacheSnapshotProvider {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly now: () => Date = () => new Date()) {}

  async current(context: UntrustedKnowledgeContext, knowledgeBaseId: string): Promise<CacheSnapshot> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const kb = validText(knowledgeBaseId, 'knowledgeBaseId', 36)
    const state = (await this.database.query<{ release_id: string | null; epoch: number;
      acl_revision: number }>(`SELECT a.release_id, a.epoch,
      COALESCE(r.revision,0) AS acl_revision FROM hz_active_releases a
      LEFT JOIN hz_acl_revisions r ON r.tenant_id=a.tenant_id
        AND r.knowledge_base_id=a.knowledge_base_id
      WHERE a.tenant_id=$1 AND a.knowledge_base_id=$2`,
    [actor.tenantId, kb])).rows[0]
    const revision = state ? Number(state.acl_revision) : Number((await this.database.query<{
      revision: number }>(`SELECT revision FROM hz_acl_revisions
      WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, kb])).rows[0]?.revision ?? 0)
    let nextBoundary: string | null = null
    if (state?.release_id) {
      const boundary = (await this.database.query<{ next_boundary: string | null }>(`
        SELECT MIN(boundary) AS next_boundary FROM (
          SELECT effective_from AS boundary FROM hz_release_entries
          WHERE tenant_id=$1 AND release_id=$2 AND effective_from > $3
          UNION ALL
          SELECT effective_to AS boundary FROM hz_release_entries
          WHERE tenant_id=$1 AND release_id=$2 AND effective_to > $3
        ) boundaries`, [actor.tenantId, state.release_id, this.now().toISOString()])).rows[0]
      nextBoundary = boundary?.next_boundary ? new Date(boundary.next_boundary).toISOString() : null
    }
    return { releaseId: state?.release_id ?? null, epoch: Number(state?.epoch ?? 0),
      aclRevision: revision, nextBoundary }
  }
}

export class KnowledgeFaqApproval implements FaqApprovalGate {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly derived: DerivedReadGate) {}

  async approve(context: UntrustedKnowledgeContext, assetId: string): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = validText(assetId, 'assetId', 36)
    const asset = (await this.database.query<{ knowledge_base_id: string; kind: string;
      status: string; created_by: string }>(`SELECT knowledge_base_id, kind, status, created_by
      FROM hz_p4_derived_assets WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, id])).rows[0]
    if (!asset || asset.kind !== 'faq' || asset.status !== 'active') {
      throw new KnowledgeError('ACCESS_DENIED', 'FAQ 不可审核')
    }
    if (asset.created_by === actor.requesterId) {
      throw new KnowledgeError('SELF_REVIEW_DENIED', 'FAQ 创建人不能自行批准')
    }
    await this.derived.authorizeDerivedRead(context, id)
    await this.database.transaction(async (tx) => {
      const inserted = (await tx.query<{ asset_id: string }>(`INSERT INTO hz_p5_faq_approvals
        (asset_id, tenant_id, knowledge_base_id, approved_by)
        VALUES ($1,$2,$3,$4) ON CONFLICT (asset_id) DO NOTHING RETURNING asset_id`,
      [id, actor.tenantId, asset.knowledge_base_id, actor.requesterId])).rows[0]
      if (!inserted) throw new KnowledgeError('REVIEW_CONFLICT', 'FAQ 已批准')
      await tx.query(`INSERT INTO hz_audit_events
        (id, tenant_id, actor_id, action, resource_type, resource_id, result, trace_id)
        VALUES ($1,$2,$3,'faq.approved','faq',$4,'success',$5)`,
      [randomUUID(), actor.tenantId, actor.requesterId, id, context.taskId ?? null])
    })
  }

  async isApprovedAndReadable(context: UntrustedKnowledgeContext, knowledgeBaseId: string,
    assetId: string): Promise<boolean> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const kb = validText(knowledgeBaseId, 'knowledgeBaseId', 36)
    const id = validText(assetId, 'assetId', 36)
    const saved = (await this.database.query(`SELECT asset_id FROM hz_p5_faq_approvals
      WHERE tenant_id=$1 AND knowledge_base_id=$2 AND asset_id=$3`,
    [actor.tenantId, kb, id])).rows[0]
    if (!saved) return false
    try {
      const asset = await this.derived.authorizeDerivedRead(context, id)
      return asset.kind === 'faq'
    } catch { return false }
  }
}
