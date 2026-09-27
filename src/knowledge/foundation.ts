import { createHash, randomUUID } from 'node:crypto'

export type KnowledgePermission = 'ingest' | 'review' | 'publish' | 'manage_acl' | 'revoke' |
  'read_history' | 'outbox' | 'audit_read' | 'record_delivery' |
  'pilot_business_signoff' | 'pilot_technical_signoff'
export type ReadSurface = 'search' | 'original' | 'parent' | 'citation' | 'download'
export type PrincipalType = 'user' | 'department' | 'group' | 'everyone'

export interface UntrustedKnowledgeContext {
  serviceCredential: string
  organizationId: string
  requesterId: string
  taskId?: string
  authorizationRef?: string
}

export interface VerifiedKnowledgeActor {
  tenantId: number
  organizationId: string
  requesterId: string
  principals: Array<{ type: PrincipalType; id: string }>
  permissions: KnowledgePermission[]
}

export interface KnowledgeIdentityVerifier {
  verify(context: UntrustedKnowledgeContext): Promise<VerifiedKnowledgeActor>
}

export async function verifyKnowledgeActor(context: UntrustedKnowledgeContext,
  identity: KnowledgeIdentityVerifier, permission?: KnowledgePermission): Promise<VerifiedKnowledgeActor> {
  if (!context?.serviceCredential) throw new KnowledgeError('UNAUTHENTICATED', '缺少服务身份')
  const actor = await identity.verify(context)
  if (!Number.isSafeInteger(actor.tenantId) || actor.tenantId <= 0 ||
      actor.organizationId !== context.organizationId || actor.requesterId !== context.requesterId ||
      !actor.principals.some((principal) => principal.type === 'user' && principal.id === actor.requesterId)) {
    throw new KnowledgeError('IDENTITY_MISMATCH', '可信身份与请求上下文不一致')
  }
  if (permission && !actor.permissions.includes(permission)) {
    throw new KnowledgeError('ACCESS_DENIED', '没有执行该操作的权限')
  }
  return actor
}

export interface KnowledgeIndexVerifier {
  verify(input: { tenantId: number; buildId: string; generation: number }): Promise<boolean>
}

export interface SqlSession {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface SqlDatabase extends SqlSession {
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>
}

export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

type VersionResult = { documentId: string; versionId: string }
type RunResult = { runId: string; buildId: string; generation: number; startedNow: boolean }
type ReleaseResult = { releaseId: string; epoch: number; idempotencyKey: string }
export type ReleaseEntry = {
  documentId: string
  versionId: string
  buildId: string
  effectiveFrom: string
  effectiveTo: string | null
}

function nonempty(value: string, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 必须为非空字符串，且长度不超过 ${max}`)
  }
  return value.trim()
}

function utc(value: string, name: string): string {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 必须为 UTC 时间`)
  }
  return new Date(value).toISOString()
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function normalizeReleaseEntries(raw: ReleaseEntry[]): ReleaseEntry[] {
  if (!Array.isArray(raw)) throw new KnowledgeError('INVALID_INPUT', '发布清单缺失')
  const entries = raw.map((entry) => ({
    documentId: nonempty(entry.documentId, 'documentId', 36),
    versionId: nonempty(entry.versionId, 'versionId', 36),
    buildId: nonempty(entry.buildId, 'buildId', 36),
    effectiveFrom: utc(entry.effectiveFrom, 'effectiveFrom'),
    effectiveTo: entry.effectiveTo === null ? null : utc(entry.effectiveTo, 'effectiveTo'),
  })).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.effectiveFrom.localeCompare(b.effectiveFrom))
  if (entries.some((entry, index) =>
    (entry.effectiveTo !== null && entry.effectiveTo <= entry.effectiveFrom) ||
    (index > 0 && entries[index - 1].documentId === entry.documentId &&
      (entries[index - 1].effectiveTo === null || entries[index - 1].effectiveTo! > entry.effectiveFrom)))) {
    throw new KnowledgeError('INVALID_INPUT', '发布条目有效区间重叠或无效')
  }
  return entries
}

export function publicationRequestHash(knowledgeBaseId: string, expectedReleaseId: string | null,
  entries: ReleaseEntry[]): string {
  return hash([knowledgeBaseId, expectedReleaseId, normalizeReleaseEntries(entries)])
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

export class KnowledgeFoundation {
  constructor(
    private readonly database: SqlDatabase,
    private readonly identity: KnowledgeIdentityVerifier,
    private readonly indexVerifier: KnowledgeIndexVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async actor(context: UntrustedKnowledgeContext, permission?: KnowledgePermission): Promise<VerifiedKnowledgeActor> {
    return verifyKnowledgeActor(context, this.identity, permission)
  }

  private async audit(tx: SqlSession, actor: VerifiedKnowledgeActor, context: UntrustedKnowledgeContext,
    action: string, resourceType: string, resourceId: string, reason: string | null = null): Promise<void> {
    await tx.query(`INSERT INTO hz_audit_events
      (id, tenant_id, actor_id, action, resource_type, resource_id, result, reason, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,'success',$7,$8)`,
    [randomUUID(), actor.tenantId, actor.requesterId, action, resourceType, resourceId, reason, context.taskId ?? null])
  }

  private async event(tx: SqlSession, tenantId: number, topic: string, aggregateId: string, payload: object): Promise<void> {
    await tx.query(`INSERT INTO hz_outbox (id, tenant_id, topic, aggregate_id, payload, available_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [randomUUID(), tenantId, topic, aggregateId, JSON.stringify(payload), this.now().toISOString()])
  }

  async registerVersion(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; sourceSystem: string; sourceDocumentId: string; sourceRevision: string;
    contentHash: string; objectRef: string
  }): Promise<VersionResult> {
    const actor = await this.actor(context, 'ingest')
    const knowledgeBaseId = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const sourceSystem = nonempty(input.sourceSystem, 'sourceSystem', 128)
    const sourceDocumentId = nonempty(input.sourceDocumentId, 'sourceDocumentId')
    const revision = nonempty(input.sourceRevision, 'sourceRevision', 256)
    const objectRef = nonempty(input.objectRef, 'objectRef', 2048)
    if (!/^[a-f0-9]{64}$/.test(input.contentHash)) throw new KnowledgeError('INVALID_INPUT', 'contentHash 必须为 SHA-256')
    return this.database.transaction(async (tx) => {
      const newDocumentId = randomUUID()
      await tx.query(`INSERT INTO hz_documents
        (id, tenant_id, organization_id, knowledge_base_id, source_system, source_document_id, owner_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id, knowledge_base_id, source_system, source_document_id) DO NOTHING`,
      [newDocumentId, actor.tenantId, actor.organizationId, knowledgeBaseId, sourceSystem, sourceDocumentId, actor.requesterId])
      const document = (await tx.query<{ id: string }>(`SELECT id FROM hz_documents
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND source_system=$3 AND source_document_id=$4`,
      [actor.tenantId, knowledgeBaseId, sourceSystem, sourceDocumentId])).rows[0]
      const existing = (await tx.query<{ id: string; content_hash: string; object_ref: string }>(`SELECT id, content_hash, object_ref
        FROM hz_document_versions WHERE tenant_id=$1 AND document_id=$2 AND source_revision=$3`,
      [actor.tenantId, document.id, revision])).rows[0]
      if (existing) {
        if (existing.content_hash !== input.contentHash || existing.object_ref !== objectRef) {
          throw new KnowledgeError('REVISION_CONFLICT', '同一来源修订号已对应另一份原件')
        }
        return { documentId: document.id, versionId: existing.id }
      }
      const versionId = randomUUID()
      await tx.query(`INSERT INTO hz_document_versions
        (id, tenant_id, document_id, source_revision, content_hash, object_ref, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id, document_id, source_revision) DO NOTHING`,
      [versionId, actor.tenantId, document.id, revision, input.contentHash, objectRef, actor.requesterId])
      const saved = (await tx.query<{ id: string; content_hash: string; object_ref: string }>(`SELECT id, content_hash, object_ref
        FROM hz_document_versions WHERE tenant_id=$1 AND document_id=$2 AND source_revision=$3`,
      [actor.tenantId, document.id, revision])).rows[0]
      if (saved.content_hash !== input.contentHash || saved.object_ref !== objectRef) {
        throw new KnowledgeError('REVISION_CONFLICT', '同一来源修订号已对应另一份原件')
      }
      if (saved.id === versionId) await this.audit(tx, actor, context, 'version.registered', 'document_version', versionId)
      return { documentId: document.id, versionId: saved.id }
    })
  }

  async getIngestVersion(context: UntrustedKnowledgeContext, versionId: string): Promise<{
    documentId: string; versionId: string; knowledgeBaseId: string; contentHash: string; objectRef: string
  }> {
    const actor = await this.actor(context, 'ingest')
    const id = nonempty(versionId, 'versionId', 36)
    const row = (await this.database.query<{ document_id: string; knowledge_base_id: string;
      content_hash: string; object_ref: string }>(`SELECT v.document_id, d.knowledge_base_id, v.content_hash, v.object_ref
      FROM hz_document_versions v JOIN hz_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
      WHERE v.tenant_id=$1 AND v.id=$2`, [actor.tenantId, id])).rows[0]
    if (!row) throw new KnowledgeError('ACCESS_DENIED', '文档版本不可访问')
    return { documentId: row.document_id, versionId: id, knowledgeBaseId: row.knowledge_base_id,
      contentHash: row.content_hash, objectRef: row.object_ref }
  }

  async addAclRule(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; resourceType: 'knowledge_base' | 'document'; resourceId: string;
    principalType: PrincipalType; principalId: string; effect: 'allow' | 'deny'
  }): Promise<{ ruleId: string; revision: number }> {
    const actor = await this.actor(context, 'manage_acl')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const resourceId = nonempty(input.resourceId, 'resourceId', 36)
    const principalId = nonempty(input.principalId, 'principalId')
    if (!['knowledge_base', 'document'].includes(input.resourceType) ||
        !['user', 'department', 'group', 'everyone'].includes(input.principalType) ||
        !['allow', 'deny'].includes(input.effect) ||
        (input.resourceType === 'knowledge_base' && resourceId !== kb) ||
        (input.principalType === 'everyone' && principalId !== '*')) {
      throw new KnowledgeError('INVALID_INPUT', 'ACL 规则无效')
    }
    return this.database.transaction(async (tx) => {
      if (input.resourceType === 'document') {
        const rows = (await tx.query(`SELECT id FROM hz_documents
          WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3`, [actor.tenantId, kb, resourceId])).rows
        if (!rows.length) throw new KnowledgeError('ACCESS_DENIED', '文档不在授权知识库中')
      }
      const ruleId = randomUUID()
      await tx.query(`INSERT INTO hz_acl_rules
        (id, tenant_id, knowledge_base_id, resource_type, resource_id, principal_type, principal_id, effect, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ruleId, actor.tenantId, kb, input.resourceType, resourceId, input.principalType, principalId, input.effect, actor.requesterId])
      const revision = (await tx.query<{ revision: number }>(`INSERT INTO hz_acl_revisions
        (tenant_id, knowledge_base_id, revision) VALUES ($1,$2,1)
        ON CONFLICT (tenant_id, knowledge_base_id) DO UPDATE SET revision=hz_acl_revisions.revision+1
        RETURNING revision`, [actor.tenantId, kb])).rows[0].revision
      await this.event(tx, actor.tenantId, 'acl.changed', kb, { revision })
      await this.audit(tx, actor, context, 'acl.rule_added', input.resourceType, resourceId)
      return { ruleId, revision: number(revision) }
    })
  }

  async revokeAclRule(context: UntrustedKnowledgeContext, ruleId: string): Promise<{ revision: number }> {
    const actor = await this.actor(context, 'manage_acl')
    const id = nonempty(ruleId, 'ruleId', 36)
    return this.database.transaction(async (tx) => {
      const rule = (await tx.query<{ knowledge_base_id: string; resource_type: string; resource_id: string; revoked_at: string | null }>(`
        SELECT knowledge_base_id, resource_type, resource_id, revoked_at FROM hz_acl_rules
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, id])).rows[0]
      if (!rule) throw new KnowledgeError('ACCESS_DENIED', 'ACL 规则不存在或不可访问')
      if (rule.revoked_at === null) {
        await tx.query(`UPDATE hz_acl_rules SET revoked_at=$3 WHERE tenant_id=$1 AND id=$2`,
          [actor.tenantId, id, this.now().toISOString()])
        const revision = (await tx.query<{ revision: number }>(`UPDATE hz_acl_revisions
          SET revision=revision+1 WHERE tenant_id=$1 AND knowledge_base_id=$2 RETURNING revision`,
          [actor.tenantId, rule.knowledge_base_id])).rows[0]
        await this.event(tx, actor.tenantId, 'acl.changed', rule.knowledge_base_id, { revision: number(revision.revision) })
        await this.audit(tx, actor, context, 'acl.rule_revoked', rule.resource_type, rule.resource_id)
      }
      const current = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_acl_revisions
        WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, rule.knowledge_base_id])).rows[0]
      return { revision: number(current.revision) }
    })
  }

  async startBuild(context: UntrustedKnowledgeContext, input: {
    versionId: string; pipelineFingerprint: string; idempotencyKey: string
  }): Promise<RunResult> {
    const actor = await this.actor(context, 'ingest')
    const versionId = nonempty(input.versionId, 'versionId', 36)
    const fingerprint = nonempty(input.pipelineFingerprint, 'pipelineFingerprint', 256)
    const key = nonempty(input.idempotencyKey, 'idempotencyKey', 256)
    return this.database.transaction(async (tx) => {
      const version = (await tx.query(`SELECT id FROM hz_document_versions WHERE tenant_id=$1 AND id=$2`,
        [actor.tenantId, versionId])).rows[0]
      if (!version) throw new KnowledgeError('ACCESS_DENIED', '文档版本不可访问')
      await tx.query(`INSERT INTO hz_builds (id, tenant_id, version_id, pipeline_fingerprint)
        VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, version_id, pipeline_fingerprint) DO NOTHING`,
      [randomUUID(), actor.tenantId, versionId, fingerprint])
      const build = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM hz_builds
        WHERE tenant_id=$1 AND version_id=$2 AND pipeline_fingerprint=$3 FOR UPDATE`,
      [actor.tenantId, versionId, fingerprint])).rows[0]
      const prior = (await tx.query<{ id: string; build_id: string; generation: number }>(`SELECT id, build_id, generation
        FROM hz_processing_runs WHERE tenant_id=$1 AND idempotency_key=$2`, [actor.tenantId, key])).rows[0]
      if (prior) {
        if (prior.build_id !== build.id) throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '幂等键已用于其他构建')
        return { runId: prior.id, buildId: prior.build_id, generation: number(prior.generation), startedNow: false }
      }
      if (build.status === 'ready') throw new KnowledgeError('BUILD_READY', '该构建已就绪，不可重新执行')
      const updated = (await tx.query<{ lease_generation: number }>(`UPDATE hz_builds
        SET status='processing', lease_generation=lease_generation+1, index_verified=FALSE, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2 RETURNING lease_generation`, [actor.tenantId, build.id])).rows[0]
      await tx.query(`UPDATE hz_processing_runs SET status='superseded'
        WHERE tenant_id=$1 AND build_id=$2 AND status='processing'`, [actor.tenantId, build.id])
      const runId = randomUUID()
      await tx.query(`INSERT INTO hz_processing_runs
        (id, tenant_id, build_id, idempotency_key, generation, status)
        VALUES ($1,$2,$3,$4,$5,'processing')`,
      [runId, actor.tenantId, build.id, key, updated.lease_generation])
      await this.audit(tx, actor, context, 'build.started', 'build', build.id)
      return { runId, buildId: build.id, generation: number(updated.lease_generation), startedNow: true }
    })
  }

  async completeBuild(context: UntrustedKnowledgeContext, input: {
    runId: string; generation: number
  }): Promise<void> {
    const actor = await this.actor(context, 'ingest')
    const runId = nonempty(input.runId, 'runId', 36)
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0) throw new KnowledgeError('INVALID_INPUT', 'generation 无效')
    const candidate = (await this.database.query<{ build_id: string }>(`SELECT build_id FROM hz_processing_runs
      WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, runId])).rows[0]
    if (!candidate) throw new KnowledgeError('STALE_RUN', '任务不存在或不在当前租户')
    if (!await this.indexVerifier.verify({ tenantId: actor.tenantId, buildId: candidate.build_id,
      generation: input.generation })) {
      throw new KnowledgeError('INDEX_NOT_VERIFIED', '索引完整性检查未通过')
    }
    await this.database.transaction(async (tx) => {
      const runRef = (await tx.query<{ build_id: string }>(`SELECT build_id FROM hz_processing_runs
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, runId])).rows[0]
      if (!runRef) throw new KnowledgeError('STALE_RUN', '任务不存在或不在当前租户')
      const build = (await tx.query<{ lease_generation: number; status: string }>(`SELECT lease_generation, status
        FROM hz_builds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, runRef.build_id])).rows[0]
      const run = (await tx.query<{ build_id: string; generation: number; status: string }>(`SELECT build_id, generation, status
        FROM hz_processing_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, runId])).rows[0]
      if (number(run.generation) !== input.generation || number(build.lease_generation) !== input.generation) {
        throw new KnowledgeError('STALE_RUN', '旧任务不能提交构建结果')
      }
      if (run.status === 'completed' && build.status === 'ready') return
      if (run.status !== 'processing' || build.status !== 'processing') throw new KnowledgeError('STALE_RUN', '任务不在可完成状态')
      await tx.query(`UPDATE hz_builds SET status='ready', index_verified=TRUE, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2 AND lease_generation=$3`, [actor.tenantId, run.build_id, input.generation])
      await tx.query(`UPDATE hz_processing_runs SET status='completed', completed_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, runId])
      await this.audit(tx, actor, context, 'build.completed', 'build', run.build_id)
    })
  }

  async failBuild(context: UntrustedKnowledgeContext, input: {
    runId: string; generation: number; reason: string
  }): Promise<void> {
    const actor = await this.actor(context, 'ingest')
    const runId = nonempty(input.runId, 'runId', 36)
    const reason = nonempty(input.reason, 'reason', 512)
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0) throw new KnowledgeError('INVALID_INPUT', 'generation 无效')
    await this.database.transaction(async (tx) => {
      const runRef = (await tx.query<{ build_id: string }>(`SELECT build_id FROM hz_processing_runs
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, runId])).rows[0]
      if (!runRef) throw new KnowledgeError('STALE_RUN', '任务不存在或不在当前租户')
      const build = (await tx.query<{ lease_generation: number; status: string }>(`SELECT lease_generation, status
        FROM hz_builds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, runRef.build_id])).rows[0]
      const run = (await tx.query<{ build_id: string; generation: number; status: string }>(`SELECT build_id, generation, status
        FROM hz_processing_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, runId])).rows[0]
      if (number(run.generation) !== input.generation || number(build.lease_generation) !== input.generation ||
          run.status !== 'processing' || build.status !== 'processing') {
        throw new KnowledgeError('STALE_RUN', '旧任务不能修改构建状态')
      }
      await tx.query(`UPDATE hz_builds SET status='failed', index_verified=FALSE, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, run.build_id])
      await tx.query(`UPDATE hz_processing_runs SET status='failed', completed_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, runId])
      await this.audit(tx, actor, context, 'build.failed', 'build', run.build_id, reason)
    })
  }

  async publish(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; expectedReleaseId: string | null; idempotencyKey: string; entries: ReleaseEntry[]
  }): Promise<ReleaseResult> {
    const actor = await this.actor(context, 'publish')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const key = nonempty(input.idempotencyKey, 'idempotencyKey', 256)
    if (!Array.isArray(input.entries) || input.expectedReleaseId === undefined) {
      throw new KnowledgeError('INVALID_INPUT', '发布清单或预期快照缺失')
    }
    const entries = normalizeReleaseEntries(input.entries)
    const requestHash = publicationRequestHash(kb, input.expectedReleaseId, entries)
    return this.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO hz_active_releases (tenant_id, knowledge_base_id)
        VALUES ($1,$2) ON CONFLICT (tenant_id, knowledge_base_id) DO NOTHING`, [actor.tenantId, kb])
      const active = (await tx.query<{ release_id: string | null; epoch: number }>(`SELECT release_id, epoch
        FROM hz_active_releases WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`, [actor.tenantId, kb])).rows[0]
      const prior = (await tx.query<{ id: string; request_hash: string; epoch: number }>(`SELECT id, request_hash, epoch
        FROM hz_releases WHERE tenant_id=$1 AND knowledge_base_id=$2 AND idempotency_key=$3`,
      [actor.tenantId, kb, key])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '发布幂等键对应不同清单')
        return { releaseId: prior.id, epoch: number(prior.epoch), idempotencyKey: key }
      }
      if (active.release_id !== input.expectedReleaseId) throw new KnowledgeError('RELEASE_CONFLICT', '活动快照已被其他发布改变')
      for (const entry of entries) {
        const valid = (await tx.query(`SELECT b.id FROM hz_builds b
          JOIN hz_document_versions v ON v.tenant_id=b.tenant_id AND v.id=b.version_id
          JOIN hz_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
          LEFT JOIN hz_version_revocations r ON r.tenant_id=v.tenant_id AND r.version_id=v.id
          WHERE b.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3 AND v.id=$4 AND b.id=$5
          AND b.status='ready' AND b.index_verified=TRUE AND r.version_id IS NULL`,
        [actor.tenantId, kb, entry.documentId, entry.versionId, entry.buildId])).rows[0]
        if (!valid) throw new KnowledgeError('BUILD_NOT_READY', '发布清单含未就绪、撤销或跨库构建')
      }
      const releaseId = randomUUID()
      const epoch = number(active.epoch) + 1
      await tx.query(`INSERT INTO hz_releases
        (id, tenant_id, knowledge_base_id, base_release_id, idempotency_key, request_hash, epoch, published_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [releaseId, actor.tenantId, kb, active.release_id, key, requestHash, epoch, actor.requesterId])
      for (const entry of entries) {
        await tx.query(`INSERT INTO hz_release_entries
          (tenant_id, release_id, document_id, version_id, build_id, effective_from, effective_to)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [actor.tenantId, releaseId, entry.documentId, entry.versionId, entry.buildId,
          entry.effectiveFrom, entry.effectiveTo])
      }
      await tx.query(`UPDATE hz_active_releases SET release_id=$3, epoch=$4
        WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, kb, releaseId, epoch])
      await this.event(tx, actor.tenantId, 'release.published', releaseId, { knowledgeBaseId: kb, epoch })
      await this.audit(tx, actor, context, 'release.published', 'release', releaseId)
      return { releaseId, epoch, idempotencyKey: key }
    })
  }

  async revokeVersion(context: UntrustedKnowledgeContext, input: { versionId: string; reason: string }): Promise<void> {
    const actor = await this.actor(context, 'revoke')
    const versionId = nonempty(input.versionId, 'versionId', 36)
    const reason = nonempty(input.reason, 'reason', 512)
    await this.database.transaction(async (tx) => {
      const version = (await tx.query(`SELECT id FROM hz_document_versions WHERE tenant_id=$1 AND id=$2`,
        [actor.tenantId, versionId])).rows[0]
      if (!version) throw new KnowledgeError('ACCESS_DENIED', '文档版本不可访问')
      const created = (await tx.query<{ version_id: string }>(`INSERT INTO hz_version_revocations
        (tenant_id, version_id, reason, revoked_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, version_id) DO NOTHING RETURNING version_id`,
      [actor.tenantId, versionId, reason, actor.requesterId])).rows[0]
      if (!created) return
      await this.event(tx, actor.tenantId, 'version.revoked', versionId, { versionId })
      await this.audit(tx, actor, context, 'version.revoked', 'document_version', versionId, reason)
    })
  }

  async authorizeRead(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; documentId: string; versionId: string; buildId: string;
    surface: ReadSurface; asOf?: string
  }): Promise<{ releaseId: string; epoch: number; aclRevision: number; effectiveFrom: string; effectiveTo: string | null }> {
    const actor = await this.actor(context)
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const doc = nonempty(input.documentId, 'documentId', 36)
    const version = nonempty(input.versionId, 'versionId', 36)
    const build = nonempty(input.buildId, 'buildId', 36)
    if (!['search', 'original', 'parent', 'citation', 'download'].includes(input.surface)) {
      throw new KnowledgeError('INVALID_INPUT', '读取面无效')
    }
    const asOf = input.asOf === undefined ? this.now().toISOString() : utc(input.asOf, 'asOf')
    if (input.asOf !== undefined && !actor.permissions.includes('read_history')) {
      throw new KnowledgeError('ACCESS_DENIED', '历史知识读取未授权')
    }
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<{ release_id: string; epoch: number; effective_from: string; effective_to: string | null }>(`SELECT a.release_id, a.epoch,
        e.effective_from, e.effective_to
        FROM hz_active_releases a
        JOIN hz_release_entries e ON e.tenant_id=a.tenant_id AND e.release_id=a.release_id
        JOIN hz_documents d ON d.tenant_id=e.tenant_id AND d.id=e.document_id
        JOIN hz_builds b ON b.tenant_id=e.tenant_id AND b.id=e.build_id
        LEFT JOIN hz_version_revocations r ON r.tenant_id=e.tenant_id AND r.version_id=e.version_id
        WHERE a.tenant_id=$1 AND a.knowledge_base_id=$2 AND e.document_id=$3
          AND e.version_id=$4 AND e.build_id=$5 AND d.knowledge_base_id=$2
          AND e.effective_from <= $6 AND (e.effective_to IS NULL OR e.effective_to > $6)
          AND b.status='ready' AND b.index_verified=TRUE AND r.version_id IS NULL`,
      [actor.tenantId, kb, doc, version, build, asOf])).rows[0]
      if (!row) throw new KnowledgeError('ACCESS_DENIED', '来源当前不可读取')
      const rules = (await tx.query<{ principal_type: PrincipalType; principal_id: string; effect: 'allow' | 'deny' }>(`
        SELECT principal_type, principal_id, effect FROM hz_acl_rules
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND revoked_at IS NULL
          AND ((resource_type='knowledge_base' AND resource_id=$2)
            OR (resource_type='document' AND resource_id=$3))`, [actor.tenantId, kb, doc])).rows
      const principals = new Set(actor.principals.map((principal) => `${principal.type}:${principal.id}`))
      const applicable = rules.filter((rule) => rule.principal_type === 'everyone' ||
        principals.has(`${rule.principal_type}:${rule.principal_id}`))
      if (applicable.some((rule) => rule.effect === 'deny') || !applicable.some((rule) => rule.effect === 'allow')) {
        throw new KnowledgeError('ACCESS_DENIED', '来源当前不可读取')
      }
      const revision = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_acl_revisions
        WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, kb])).rows[0]
      return { releaseId: row.release_id, epoch: number(row.epoch), aclRevision: number(revision?.revision ?? 0),
        effectiveFrom: new Date(row.effective_from).toISOString(),
        effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString() }
    })
  }

  async authorizeArchivedRead(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; releaseId: string; documentId: string; versionId: string;
    buildId: string; asOf: string; surface: ReadSurface
  }): Promise<{ releaseId: string; epoch: number; aclRevision: number;
    effectiveFrom: string; effectiveTo: string | null }> {
    const actor = await this.actor(context, 'read_history')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const releaseId = nonempty(input.releaseId, 'releaseId', 36)
    const documentId = nonempty(input.documentId, 'documentId', 36)
    const versionId = nonempty(input.versionId, 'versionId', 36)
    const buildId = nonempty(input.buildId, 'buildId', 36)
    const asOf = utc(input.asOf, 'asOf')
    if (!['search', 'original', 'parent', 'citation', 'download'].includes(input.surface)) {
      throw new KnowledgeError('INVALID_INPUT', '读取面无效')
    }
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<{ epoch: number; effective_from: string; effective_to: string | null }>(`
        SELECT r.epoch, e.effective_from, e.effective_to FROM hz_releases r
        JOIN hz_release_entries e ON e.tenant_id=r.tenant_id AND e.release_id=r.id
        JOIN hz_documents d ON d.tenant_id=e.tenant_id AND d.id=e.document_id
        JOIN hz_builds b ON b.tenant_id=e.tenant_id AND b.id=e.build_id
        LEFT JOIN hz_version_revocations v ON v.tenant_id=e.tenant_id AND v.version_id=e.version_id
        WHERE r.tenant_id=$1 AND r.knowledge_base_id=$2 AND r.id=$3
          AND d.knowledge_base_id=$2 AND e.document_id=$4 AND e.version_id=$5 AND e.build_id=$6
          AND e.effective_from <= $7 AND (e.effective_to IS NULL OR e.effective_to > $7)
          AND b.status='ready' AND b.index_verified=TRUE AND v.version_id IS NULL`,
      [actor.tenantId, kb, releaseId, documentId, versionId, buildId, asOf])).rows[0]
      if (!row) throw new KnowledgeError('ACCESS_DENIED', '历史来源当前不可读取')
      const rules = (await tx.query<{ principal_type: PrincipalType; principal_id: string;
        effect: 'allow' | 'deny' }>(`SELECT principal_type, principal_id, effect FROM hz_acl_rules
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND revoked_at IS NULL
          AND ((resource_type='knowledge_base' AND resource_id=$2)
            OR (resource_type='document' AND resource_id=$3))`,
      [actor.tenantId, kb, documentId])).rows
      const principals = new Set(actor.principals.map((principal) => `${principal.type}:${principal.id}`))
      const applicable = rules.filter((rule) => rule.principal_type === 'everyone' ||
        principals.has(`${rule.principal_type}:${rule.principal_id}`))
      if (applicable.some((rule) => rule.effect === 'deny') || !applicable.some((rule) => rule.effect === 'allow')) {
        throw new KnowledgeError('ACCESS_DENIED', '历史来源当前不可读取')
      }
      const revision = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_acl_revisions
        WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, kb])).rows[0]
      return { releaseId, epoch: number(row.epoch), aclRevision: number(revision?.revision ?? 0),
        effectiveFrom: new Date(row.effective_from).toISOString(),
        effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString() }
    })
  }

  async leaseOutbox(context: UntrustedKnowledgeContext, input: { limit: number; leaseSeconds: number }): Promise<Array<{
    eventId: string; topic: string; aggregateId: string; payload: Record<string, unknown>;
    leaseToken: string; attempts: number
  }>> {
    const actor = await this.actor(context, 'outbox')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
        !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) {
      throw new KnowledgeError('INVALID_INPUT', 'Outbox 租约参数无效')
    }
    const now = this.now()
    const until = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString()
    return this.database.transaction(async (tx) => {
      const pending = (await tx.query<{ id: string; topic: string; aggregate_id: string; payload: Record<string, unknown> }>(`
        SELECT id, topic, aggregate_id, payload FROM hz_outbox
        WHERE tenant_id=$1 AND delivered_at IS NULL AND available_at <= $2
          AND (claimed_until IS NULL OR claimed_until <= $2)
        ORDER BY created_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [actor.tenantId, now.toISOString(), input.limit])).rows
      const leased = []
      for (const event of pending) {
        const leaseToken = randomUUID()
        const updated = (await tx.query<{ attempts: number }>(`UPDATE hz_outbox
          SET claimed_until=$3, lease_token=$4, attempts=attempts+1
          WHERE tenant_id=$1 AND id=$2 RETURNING attempts`,
        [actor.tenantId, event.id, until, leaseToken])).rows[0]
        leased.push({ eventId: event.id, topic: event.topic, aggregateId: event.aggregate_id,
          payload: event.payload, leaseToken, attempts: number(updated.attempts) })
      }
      return leased
    })
  }

  async ackOutbox(context: UntrustedKnowledgeContext, input: { eventId: string; leaseToken: string }): Promise<void> {
    const actor = await this.actor(context, 'outbox')
    const eventId = nonempty(input.eventId, 'eventId', 36)
    const token = nonempty(input.leaseToken, 'leaseToken', 36)
    const result = await this.database.query(`UPDATE hz_outbox SET delivered_at=$4, claimed_until=NULL, lease_token=NULL
      WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL
      RETURNING id`, [actor.tenantId, eventId, token, this.now().toISOString()])
    if (!result.rows.length) throw new KnowledgeError('STALE_EVENT_LEASE', '事件租约已失效')
  }

  async failOutbox(context: UntrustedKnowledgeContext, input: {
    eventId: string; leaseToken: string; retryAfterSeconds: number
  }): Promise<void> {
    const actor = await this.actor(context, 'outbox')
    const eventId = nonempty(input.eventId, 'eventId', 36)
    const token = nonempty(input.leaseToken, 'leaseToken', 36)
    if (!Number.isSafeInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 0 || input.retryAfterSeconds > 86400) {
      throw new KnowledgeError('INVALID_INPUT', 'retryAfterSeconds 无效')
    }
    const availableAt = new Date(this.now().getTime() + input.retryAfterSeconds * 1000).toISOString()
    const result = await this.database.query(`UPDATE hz_outbox
      SET available_at=$4, claimed_until=NULL, lease_token=NULL
      WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL
      RETURNING id`, [actor.tenantId, eventId, token, availableAt])
    if (!result.rows.length) throw new KnowledgeError('STALE_EVENT_LEASE', '事件租约已失效')
  }
}
