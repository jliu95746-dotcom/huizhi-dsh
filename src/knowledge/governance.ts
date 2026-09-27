import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, normalizeReleaseEntries, publicationRequestHash, verifyKnowledgeActor,
  type KnowledgeIdentityVerifier, type ReleaseEntry, type SqlDatabase, type SqlSession,
  type UntrustedKnowledgeContext, type KnowledgeFoundation } from './foundation.js'
import { compareCriticalText } from './governance-policy.js'
import { KnowledgeCatalog } from './governance-catalog.js'
import type { GovernanceRule } from './governance-policy.js'
import { KnowledgeDerived } from './derived.js'

export interface ReviewEvidenceStore { loadText(sourceRef: string): Promise<string | null> }
export type ReviewKind = 'duplicate' | 'conflict' | 'cleaning'
export type ReviewAction = 'mark_duplicate' | 'keep_both' | 'confirm_supersession' | 'mark_exception' |
  'false_positive' | 'keep_unresolved' | 'accept_change' | 'reject_change'
export interface ReleasePreview { added: ReleaseEntry[]; removed: ReleaseEntry[];
  changed: Array<{ before: ReleaseEntry; after: ReleaseEntry }>; unchanged: ReleaseEntry[];
  affectedDerivedIds: string[] }
export interface ReleaseProposalResult { proposalId: string; preview: ReleasePreview; status: string }

const sourcePattern = /^knowledge:([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,128})$/
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const data = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
const nonempty = (value: string, name: string, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 必须为非空字符串且长度不超过 ${max}`)
  }
  return value.trim()
}
const parseSource = (ref: string) => {
  const match = typeof ref === 'string' ? ref.match(sourcePattern) : null
  if (!match) throw new KnowledgeError('INVALID_SOURCE_REF', '审核证据来源编号无效')
  return { documentId: match[1], versionId: match[2], buildId: match[3], chunkId: match[4] }
}
const entryKey = (entry: ReleaseEntry) => `${entry.documentId}:${entry.effectiveFrom}`
function previewRelease(before: ReleaseEntry[], after: ReleaseEntry[]): ReleasePreview {
  const old = new Map(before.map((entry) => [entryKey(entry), entry]))
  const next = new Map(after.map((entry) => [entryKey(entry), entry]))
  const preview: ReleasePreview = { added: [], removed: [], changed: [], unchanged: [], affectedDerivedIds: [] }
  for (const entry of after) {
    const prior = old.get(entryKey(entry))
    if (!prior) preview.added.push(entry)
    else if (prior.versionId === entry.versionId && prior.buildId === entry.buildId &&
      prior.effectiveTo === entry.effectiveTo) preview.unchanged.push(entry)
    else preview.changed.push({ before: prior, after: entry })
  }
  for (const entry of before) if (!next.has(entryKey(entry))) preview.removed.push(entry)
  return preview
}

export class KnowledgeGovernance {
  private readonly catalog: KnowledgeCatalog
  private readonly derived: KnowledgeDerived
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly foundation: KnowledgeFoundation, private readonly evidence: ReviewEvidenceStore,
    private readonly now: () => Date = () => new Date()) {
    this.catalog = new KnowledgeCatalog(database, identity, evidence)
    this.derived = new KnowledgeDerived(database, identity, foundation, now)
  }

  createEntity(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    canonicalName: string; entityType: string }) { return this.catalog.createEntity(context, input) }
  addEntityAlias(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    entityId: string; alias: string; sourceRef: string }) { return this.catalog.addEntityAlias(context, input) }
  resolveEntity(context: UntrustedKnowledgeContext, knowledgeBaseId: string, alias: string) {
    return this.catalog.resolveEntity(context, knowledgeBaseId, alias)
  }
  submitRuleSuggestion(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    rule: Omit<GovernanceRule, 'id'> }) { return this.catalog.submitRuleSuggestion(context, input) }
  confirmRuleSuggestion(context: UntrustedKnowledgeContext, ruleId: string) {
    return this.catalog.confirmRuleSuggestion(context, ruleId)
  }
  registerDerived(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    kind: 'summary' | 'faq' | 'wiki' | 'graph'; objectRef: string; sources: string[] }) {
    return this.derived.register(context, input)
  }
  authorizeDerivedRead(context: UntrustedKnowledgeContext, assetId: string) {
    return this.derived.authorizeRead(context, assetId)
  }
  reconcileDerived(context: UntrustedKnowledgeContext, assetId: string) {
    return this.derived.reconcile(context, assetId)
  }

  private async audit(tx: SqlSession, tenantId: number, actorId: string, context: UntrustedKnowledgeContext,
    action: string, resourceType: string, resourceId: string, reason: string): Promise<void> {
    await tx.query(`INSERT INTO hz_audit_events
      (id, tenant_id, actor_id, action, resource_type, resource_id, result, reason, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,'success',$7,$8)`,
    [randomUUID(), tenantId, actorId, action, resourceType, resourceId, reason, context.taskId ?? null])
  }

  private async assertSource(tenantId: number, knowledgeBaseId: string, sourceRef: string): Promise<string> {
    const parsed = parseSource(sourceRef)
    const row = (await this.database.query(`SELECT d.id FROM hz_documents d
      JOIN hz_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      JOIN hz_builds b ON b.tenant_id=v.tenant_id AND b.version_id=v.id
      WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3 AND v.id=$4 AND b.id=$5`,
    [tenantId, knowledgeBaseId, parsed.documentId, parsed.versionId, parsed.buildId])).rows[0]
    if (!row) throw new KnowledgeError('ACCESS_DENIED', '审核来源不可访问')
    return parsed.documentId
  }

  async createReviewCase(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; kind: ReviewKind; leftRef: string; rightRef: string; reason: string
  }): Promise<{ caseId: string; revision: number }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const reason = nonempty(input.reason, 'reason')
    if (!['duplicate', 'conflict', 'cleaning'].includes(input.kind) || input.leftRef === input.rightRef) {
      throw new KnowledgeError('INVALID_INPUT', '审核候选类型或来源无效')
    }
    const documents = await Promise.all([this.assertSource(actor.tenantId, kb, input.leftRef),
      this.assertSource(actor.tenantId, kb, input.rightRef)])
    const [leftText, rightText] = await Promise.all([this.evidence.loadText(input.leftRef),
      this.evidence.loadText(input.rightRef)])
    if (!leftText?.trim() || !rightText?.trim()) throw new KnowledgeError('REVIEW_SOURCE_MISSING', '审核原文不可读取')
    const caseId = randomUUID()
    await this.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO hz_p4_review_cases
        (id, tenant_id, knowledge_base_id, kind, left_ref, right_ref, left_hash, right_hash, document_ids, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [caseId, actor.tenantId, kb, input.kind, input.leftRef, input.rightRef,
        sha256(leftText), sha256(rightText), JSON.stringify([...new Set(documents)]), actor.requesterId])
      await this.audit(tx, actor.tenantId, actor.requesterId, context, 'review.created', 'review_case', caseId, reason)
    })
    return { caseId, revision: 1 }
  }

  async decideReviewCase(context: UntrustedKnowledgeContext, input: {
    caseId: string; expectedRevision: number; action: ReviewAction; reason: string
  }): Promise<{ revision: number; status: 'pending' | 'resolved' }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const caseId = nonempty(input.caseId, 'caseId', 36)
    const reason = nonempty(input.reason, 'reason')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new KnowledgeError('INVALID_INPUT', '审核修订号无效')
    }
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<{ kind: ReviewKind; left_ref: string; right_ref: string; left_hash: string;
        right_hash: string; status: string; revision: number; created_by: string }>(`
        SELECT kind, left_ref, right_ref, left_hash, right_hash, status, revision, created_by
        FROM hz_p4_review_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, caseId])).rows[0]
      if (!row) throw new KnowledgeError('ACCESS_DENIED', '审核候选不可访问')
      if (row.created_by === actor.requesterId) throw new KnowledgeError('SELF_REVIEW_DENIED', '提交人不能审批自己的候选')
      if (row.status !== 'pending' || Number(row.revision) !== input.expectedRevision) {
        throw new KnowledgeError('REVIEW_CONFLICT', '审核候选状态已变化')
      }
      const actions: Record<ReviewKind, ReviewAction[]> = {
        duplicate: ['mark_duplicate', 'keep_both'],
        conflict: ['confirm_supersession', 'mark_exception', 'false_positive', 'keep_unresolved'],
        cleaning: ['accept_change', 'reject_change'],
      }
      if (!actions[row.kind].includes(input.action)) throw new KnowledgeError('INVALID_INPUT', '审核动作与候选类型不匹配')
      if (input.action === 'confirm_supersession' || input.action === 'mark_exception') {
        throw new KnowledgeError('DECISION_EVIDENCE_REQUIRED', '替代或例外裁决需要明确胜出规则和适用范围')
      }
      const [left, right] = await Promise.all([this.evidence.loadText(row.left_ref), this.evidence.loadText(row.right_ref)])
      if (!left || !right || sha256(left) !== row.left_hash || sha256(right) !== row.right_hash) {
        throw new KnowledgeError('REVIEW_SOURCE_CHANGED', '审核原文已变化，需重新生成候选')
      }
      if (input.action === 'mark_duplicate' && !compareCriticalText(left, right).safeToMarkDuplicate) {
        throw new KnowledgeError('DUPLICATE_CRITICAL_DIFFERENCE', '数字、单位、否定词或适用范围不同，不能标记为重复')
      }
      const status = input.action === 'keep_unresolved' ? 'pending' : 'resolved'
      const revision = Number(row.revision) + 1
      await tx.query(`UPDATE hz_p4_review_cases SET status=$3, revision=$4, decided_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, caseId, status, revision])
      await tx.query(`INSERT INTO hz_p4_review_decisions
        (id, tenant_id, case_id, action, reason, decided_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), actor.tenantId, caseId, input.action, reason, actor.requesterId])
      await this.audit(tx, actor.tenantId, actor.requesterId, context, 'review.decided', 'review_case', caseId, reason)
      return { revision, status }
    })
  }

  async proposeRelease(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; expectedReleaseId: string | null; idempotencyKey: string; entries: ReleaseEntry[];
    reason: string; publishNotBefore?: string; rollbackOf?: string
  }): Promise<ReleaseProposalResult> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'publish')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const key = nonempty(input.idempotencyKey, 'idempotencyKey', 256)
    const reason = nonempty(input.reason, 'reason')
    if (input.expectedReleaseId === undefined) throw new KnowledgeError('INVALID_INPUT', '预期快照缺失')
    const entries = normalizeReleaseEntries(input.entries)
    if (!entries.length) throw new KnowledgeError('INVALID_INPUT', '发布清单不能为空')
    const requestHash = publicationRequestHash(kb, input.expectedReleaseId, entries)
    const publishNotBefore = input.publishNotBefore ?? '1970-01-01T00:00:00Z'
    if (Number.isNaN(Date.parse(publishNotBefore)) || !publishNotBefore.endsWith('Z')) {
      throw new KnowledgeError('INVALID_INPUT', '定时发布时间必须为 UTC')
    }
    return this.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO hz_active_releases (tenant_id, knowledge_base_id)
        VALUES ($1,$2) ON CONFLICT (tenant_id, knowledge_base_id) DO NOTHING`, [actor.tenantId, kb])
      const active = (await tx.query<{ release_id: string | null }>(`SELECT release_id FROM hz_active_releases
        WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`, [actor.tenantId, kb])).rows[0]
      const prior = (await tx.query<{ id: string; request_hash: string; preview: ReleasePreview; status: string;
        reason: string; publish_not_before: string; rollback_of: string | null }>(`
        SELECT id, request_hash, preview, status, reason, publish_not_before, rollback_of FROM hz_p4_release_proposals
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND idempotency_key=$3`, [actor.tenantId, kb, key])).rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash || prior.reason !== reason ||
          new Date(prior.publish_not_before).toISOString() !== new Date(publishNotBefore).toISOString() ||
          prior.rollback_of !== (input.rollbackOf ?? null)) {
          throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '提案幂等键对应不同内容或发布时间')
        }
        return { proposalId: prior.id, preview: data(prior.preview), status: prior.status }
      }
      if (active.release_id !== input.expectedReleaseId) throw new KnowledgeError('RELEASE_CONFLICT', '活动快照已变化')
      for (const entry of entries) {
        const valid = (await tx.query(`SELECT b.id FROM hz_builds b
          JOIN hz_document_versions v ON v.tenant_id=b.tenant_id AND v.id=b.version_id
          JOIN hz_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
          LEFT JOIN hz_version_revocations r ON r.tenant_id=v.tenant_id AND r.version_id=v.id
          WHERE b.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3 AND v.id=$4 AND b.id=$5
          AND b.status='ready' AND b.index_verified=TRUE AND r.version_id IS NULL`,
        [actor.tenantId, kb, entry.documentId, entry.versionId, entry.buildId])).rows[0]
        if (!valid) throw new KnowledgeError('BUILD_NOT_READY', '提案包含未就绪或已撤销版本')
      }
      const previous = input.expectedReleaseId ? (await tx.query<{ document_id: string; version_id: string;
        build_id: string; effective_from: string; effective_to: string | null }>(`
        SELECT document_id, version_id, build_id, effective_from, effective_to FROM hz_release_entries
        WHERE tenant_id=$1 AND release_id=$2`, [actor.tenantId, input.expectedReleaseId])).rows.map((row) => ({
        documentId: row.document_id, versionId: row.version_id, buildId: row.build_id,
        effectiveFrom: new Date(row.effective_from).toISOString(),
        effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString(),
      })) : []
      const preview = previewRelease(previous, entries)
      const retained = new Set(entries.map((entry) =>
        `${entry.documentId}:${entry.versionId}:${entry.buildId}`))
      const derived = (await tx.query<{ id: string; sources: Array<{
        documentId: string; versionId: string; buildId: string }> }>(`SELECT id, sources FROM hz_p4_derived_assets
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status='active'`, [actor.tenantId, kb])).rows
      preview.affectedDerivedIds = derived.filter((asset) =>
        data<Array<{ documentId: string; versionId: string; buildId: string }>>(asset.sources)
          .some((source) => !retained.has(`${source.documentId}:${source.versionId}:${source.buildId}`)))
        .map((asset) => asset.id)
      const proposalId = randomUUID()
      await tx.query(`INSERT INTO hz_p4_release_proposals
        (id, tenant_id, knowledge_base_id, expected_release_id, idempotency_key, request_hash, entries,
         preview, reason, rollback_of, publish_not_before, proposed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
      [proposalId, actor.tenantId, kb, input.expectedReleaseId, key, requestHash,
        JSON.stringify(entries), JSON.stringify(preview), reason, input.rollbackOf ?? null,
        publishNotBefore, actor.requesterId])
      await this.audit(tx, actor.tenantId, actor.requesterId, context, 'release.proposed', 'release', proposalId, reason)
      return { proposalId, preview, status: 'draft' }
    })
  }

  async approveRelease(context: UntrustedKnowledgeContext, proposalId: string, reason: string): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = nonempty(proposalId, 'proposalId', 36)
    const approvalReason = nonempty(reason, 'reason')
    await this.database.transaction(async (tx) => {
      const proposal = (await tx.query<{ knowledge_base_id: string; expected_release_id: string | null;
        entries: ReleaseEntry[]; proposed_by: string; status: string }>(`
        SELECT knowledge_base_id, expected_release_id, entries, proposed_by, status
        FROM hz_p4_release_proposals WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, id])).rows[0]
      if (!proposal) throw new KnowledgeError('ACCESS_DENIED', '发布提案不可访问')
      if (proposal.proposed_by === actor.requesterId) throw new KnowledgeError('SELF_REVIEW_DENIED', '提案人不能审批自己')
      if (proposal.status !== 'draft') throw new KnowledgeError('REVIEW_CONFLICT', '发布提案已处理')
      const active = (await tx.query<{ release_id: string | null }>(`SELECT release_id FROM hz_active_releases
        WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`, [actor.tenantId, proposal.knowledge_base_id])).rows[0]
      if (active?.release_id !== proposal.expected_release_id) throw new KnowledgeError('RELEASE_CONFLICT', '活动快照已变化')
      const docs = new Set(data<ReleaseEntry[]>(proposal.entries).map((entry) => entry.documentId))
      const pending = (await tx.query<{ document_ids: string[] }>(`SELECT document_ids FROM hz_p4_review_cases
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status='pending'`,
      [actor.tenantId, proposal.knowledge_base_id])).rows
      if (pending.some((row) => data<string[]>(row.document_ids).some((doc) => docs.has(doc)))) {
        throw new KnowledgeError('REVIEW_PENDING', '相关文档仍有未裁决候选')
      }
      await tx.query(`UPDATE hz_p4_release_proposals SET status='approved', revision=revision+1,
        approved_by=$3, approval_reason=$4, approved_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, id, actor.requesterId, approvalReason])
      await this.audit(tx, actor.tenantId, actor.requesterId, context, 'release.approved', 'release', id, approvalReason)
    })
  }

  async publishApproved(context: UntrustedKnowledgeContext, proposalId: string): Promise<{
    releaseId: string; epoch: number
  }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'publish')
    const id = nonempty(proposalId, 'proposalId', 36)
    const proposal = (await this.database.query<{ knowledge_base_id: string; expected_release_id: string | null;
      idempotency_key: string; entries: ReleaseEntry[]; status: string; publish_not_before: string;
      released_id: string | null }>(`SELECT knowledge_base_id, expected_release_id, idempotency_key,
      entries, status, publish_not_before, released_id FROM hz_p4_release_proposals
      WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, id])).rows[0]
    if (!proposal) throw new KnowledgeError('ACCESS_DENIED', '发布提案不可访问')
    if (proposal.status === 'published' && proposal.released_id) {
      const saved = (await this.database.query<{ epoch: number }>(`SELECT epoch FROM hz_releases
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, proposal.released_id])).rows[0]
      if (saved) return { releaseId: proposal.released_id, epoch: Number(saved.epoch) }
    }
    if (proposal.status !== 'approved') throw new KnowledgeError('REVIEW_PENDING', '发布提案尚未审批')
    if (new Date(proposal.publish_not_before).getTime() > this.now().getTime()) {
      throw new KnowledgeError('NOT_DUE', '定时发布时间尚未到达')
    }
    const result = await this.foundation.publish(context, { knowledgeBaseId: proposal.knowledge_base_id,
      expectedReleaseId: proposal.expected_release_id, idempotencyKey: proposal.idempotency_key,
      entries: data(proposal.entries) })
    await this.database.transaction(async (tx) => {
      await tx.query(`UPDATE hz_p4_release_proposals SET status='published', released_id=$3,
        published_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2 AND status='approved'`,
      [actor.tenantId, id, result.releaseId])
      await this.audit(tx, actor.tenantId, actor.requesterId, context, 'release.proposal_published',
        'release', id, 'approved')
    })
    return { releaseId: result.releaseId, epoch: result.epoch }
  }

  async proposeRollback(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    targetReleaseId: string; expectedReleaseId: string; idempotencyKey: string; reason: string
  }): Promise<ReleaseProposalResult> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'publish')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const target = nonempty(input.targetReleaseId, 'targetReleaseId', 36)
    const release = (await this.database.query(`SELECT id FROM hz_releases
      WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3`, [actor.tenantId, kb, target])).rows[0]
    if (!release) throw new KnowledgeError('ACCESS_DENIED', '回退目标不可访问')
    const rows = (await this.database.query<{ document_id: string; version_id: string; build_id: string;
      effective_from: string; effective_to: string | null }>(`SELECT document_id, version_id, build_id,
      effective_from, effective_to FROM hz_release_entries WHERE tenant_id=$1 AND release_id=$2`,
    [actor.tenantId, target])).rows
    return this.proposeRelease(context, { knowledgeBaseId: kb, expectedReleaseId: input.expectedReleaseId,
      idempotencyKey: input.idempotencyKey, reason: input.reason, rollbackOf: target,
      entries: rows.map((row) => ({ documentId: row.document_id, versionId: row.version_id,
        buildId: row.build_id, effectiveFrom: new Date(row.effective_from).toISOString(),
        effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString() })) })
  }
}
