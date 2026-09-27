import { randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeFoundation,
  type KnowledgeIdentityVerifier, type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'

interface SourceDependency { knowledgeBaseId: string; documentId: string; versionId: string;
  buildId: string; chunkId: string; sourceRef: string }
const sourcePattern = /^knowledge:([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,128})$/
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value

export class KnowledgeDerived {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly foundation: KnowledgeFoundation, private readonly now: () => Date = () => new Date()) {}

  async register(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    kind: 'summary' | 'faq' | 'wiki' | 'graph'; objectRef: string; sources: string[] }): Promise<{ assetId: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    if (!input.knowledgeBaseId?.trim() || input.knowledgeBaseId.length > 36 ||
        !['summary', 'faq', 'wiki', 'graph'].includes(input.kind) ||
        !/^private:\/\/[A-Za-z0-9/_-]+$/.test(input.objectRef) ||
        !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 64 ||
        new Set(input.sources).size !== input.sources.length) {
      throw new KnowledgeError('INVALID_INPUT', '派生内容来源或对象引用无效')
    }
    const deps: SourceDependency[] = []
    for (const sourceRef of input.sources) {
      const match = sourceRef.match(sourcePattern)
      if (!match) throw new KnowledgeError('INVALID_SOURCE_REF', '派生来源编号无效')
      const row = (await this.database.query<{ knowledge_base_id: string }>(`SELECT d.knowledge_base_id
        FROM hz_documents d JOIN hz_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
        JOIN hz_builds b ON b.tenant_id=v.tenant_id AND b.version_id=v.id
        WHERE d.tenant_id=$1 AND d.id=$2 AND v.id=$3 AND b.id=$4`,
      [actor.tenantId, match[1], match[2], match[3]])).rows[0]
      if (!row || row.knowledge_base_id !== input.knowledgeBaseId) {
        throw new KnowledgeError('ACCESS_DENIED', '派生来源不可访问')
      }
      await this.foundation.authorizeRead(context, { knowledgeBaseId: input.knowledgeBaseId,
        documentId: match[1], versionId: match[2], buildId: match[3], surface: 'search' })
      deps.push({ sourceRef, knowledgeBaseId: input.knowledgeBaseId, documentId: match[1],
        versionId: match[2], buildId: match[3], chunkId: match[4] })
    }
    const assetId = randomUUID()
    await this.database.query(`INSERT INTO hz_p4_derived_assets
      (id, tenant_id, knowledge_base_id, kind, object_ref, sources, created_by)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [assetId, actor.tenantId, input.knowledgeBaseId, input.kind, input.objectRef,
      JSON.stringify(deps), actor.requesterId])
    return { assetId }
  }

  async authorizeRead(context: UntrustedKnowledgeContext, assetId: string): Promise<{
    objectRef: string; kind: string; sourceRefs: string[]
  }> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const row = (await this.database.query<{ object_ref: string; kind: string; sources: SourceDependency[];
      status: string }>(`SELECT object_ref, kind, sources, status FROM hz_p4_derived_assets
      WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, assetId])).rows[0]
    if (!row || row.status !== 'active') throw new KnowledgeError('ACCESS_DENIED', '派生内容不可读取')
    const sources = decode<SourceDependency[]>(row.sources)
    if (!Array.isArray(sources) || !sources.length) throw new KnowledgeError('ACCESS_DENIED', '派生来源不完整')
    for (const source of sources) {
      try { await this.foundation.authorizeRead(context, { knowledgeBaseId: source.knowledgeBaseId,
        documentId: source.documentId, versionId: source.versionId, buildId: source.buildId, surface: 'search' }) }
      catch { throw new KnowledgeError('ACCESS_DENIED', '派生内容不可读取') }
    }
    return { objectRef: row.object_ref, kind: row.kind, sourceRefs: sources.map((item) => item.sourceRef) }
  }

  async reconcile(context: UntrustedKnowledgeContext, assetId: string): Promise<'active' | 'quarantined'> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    const row = (await this.database.query<{ knowledge_base_id: string; sources: SourceDependency[];
      status: 'active' | 'quarantined' }>(`SELECT knowledge_base_id, sources, status FROM hz_p4_derived_assets
      WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, assetId])).rows[0]
    if (!row) throw new KnowledgeError('ACCESS_DENIED', '派生内容不可访问')
    if (row.status === 'quarantined') return 'quarantined'
    const sources = decode<SourceDependency[]>(row.sources)
    let valid = Array.isArray(sources) && sources.length > 0
    for (const source of Array.isArray(sources) ? sources : []) {
      const current = (await this.database.query(`SELECT e.document_id FROM hz_active_releases a
        JOIN hz_release_entries e ON e.tenant_id=a.tenant_id AND e.release_id=a.release_id
        JOIN hz_builds b ON b.tenant_id=e.tenant_id AND b.id=e.build_id
        LEFT JOIN hz_version_revocations r ON r.tenant_id=e.tenant_id AND r.version_id=e.version_id
        WHERE a.tenant_id=$1 AND a.knowledge_base_id=$2 AND e.document_id=$3 AND e.version_id=$4
          AND e.build_id=$5 AND e.effective_from <= $6
          AND (e.effective_to IS NULL OR e.effective_to > $6)
          AND b.status='ready' AND b.index_verified=TRUE AND r.version_id IS NULL`,
      [actor.tenantId, source.knowledgeBaseId, source.documentId, source.versionId,
        source.buildId, this.now().toISOString()])).rows[0]
      if (!current) { valid = false; break }
    }
    if (valid) return 'active'
    await this.database.transaction(async (tx) => {
      const changed = (await tx.query<{ id: string }>(`UPDATE hz_p4_derived_assets
        SET status='quarantined', quarantined_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING id`, [actor.tenantId, assetId])).rows[0]
      if (changed) {
        await tx.query(`INSERT INTO hz_outbox (id, tenant_id, topic, aggregate_id, payload)
          VALUES ($1,$2,'derived.quarantined',$3,$4::jsonb)`,
        [randomUUID(), actor.tenantId, assetId, JSON.stringify({ assetId })])
      }
    })
    return 'quarantined'
  }
}
