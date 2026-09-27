import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeFoundation,
  type KnowledgeIdentityVerifier, type SqlDatabase, type SqlSession,
  type UntrustedKnowledgeContext } from './foundation.js'

export type FeedbackCategory = 'parsing_error' | 'missing_document' | 'retrieval_error' |
  'expired' | 'conflict' | 'generation_error' | 'citation_error' | 'experience'
export type ExpectedStatus = 'ok' | 'no_evidence' | 'needs_clarification' | 'unresolved_conflict' | 'degraded'
const categories: FeedbackCategory[] = ['parsing_error', 'missing_document', 'retrieval_error',
  'expired', 'conflict', 'generation_error', 'citation_error', 'experience']
const statuses: ExpectedStatus[] = ['ok', 'no_evidence', 'needs_clarification', 'unresolved_conflict', 'degraded']
const refPattern = /^knowledge:([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,128})$/
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const decoded = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
const required = (value: string, name: string, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 无效`)
  }
  return value.trim()
}
const reference = (value: string) => {
  const parts = typeof value === 'string' ? value.match(refPattern) : null
  if (!parts) throw new KnowledgeError('INVALID_SOURCE_REF', '来源编号无效')
  return { documentId: parts[1], versionId: parts[2], buildId: parts[3] }
}
async function audit(tx: SqlSession, tenantId: number, actorId: string,
  context: UntrustedKnowledgeContext, action: string, resourceId: string, reason: string) {
  await tx.query(`INSERT INTO hz_audit_events
    (id, tenant_id, actor_id, action, resource_type, resource_id, result, reason, trace_id)
    VALUES ($1,$2,$3,$4,'feedback',$5,'success',$6,$7)`,
  [randomUUID(), tenantId, actorId, action, resourceId, reason, context.taskId ?? null])
}

export class KnowledgeFeedback {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly foundation: KnowledgeFoundation) {}

  async recordDelivery(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    traceId: string; question: string; status: 'ready' | 'rejected'; sourceRefs: string[];
    searchVersion: string }): Promise<{ receiptId: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'record_delivery')
    const kb = required(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const traceId = required(input.traceId, 'traceId', 128)
    const question = required(input.question, 'question', 4000)
    const searchVersion = required(input.searchVersion, 'searchVersion', 128)
    if (!['ready', 'rejected'].includes(input.status) || !Array.isArray(input.sourceRefs) ||
      input.sourceRefs.length > 16 || new Set(input.sourceRefs).size !== input.sourceRefs.length ||
      input.status === 'ready' && input.sourceRefs.length === 0) {
      throw new KnowledgeError('INVALID_INPUT', '交付状态或来源无效')
    }
    for (const sourceRef of input.sourceRefs) {
      const ref = reference(sourceRef)
      await this.foundation.authorizeRead(context, { knowledgeBaseId: kb, ...ref, surface: 'citation' })
    }
    const questionHash = hash(question)
    return this.database.transaction(async (tx) => {
      const receiptId = randomUUID()
      await tx.query(`INSERT INTO hz_p5_answer_receipts
        (id, tenant_id, knowledge_base_id, trace_id, requester_id, question_hash,
         delivery_status, source_refs, search_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        ON CONFLICT (tenant_id, trace_id) DO NOTHING`,
      [receiptId, actor.tenantId, kb, traceId, actor.requesterId, questionHash,
        input.status, JSON.stringify(input.sourceRefs), searchVersion])
      const saved = (await tx.query<{ id: string; knowledge_base_id: string; requester_id: string;
        question_hash: string; delivery_status: string; source_refs: string[]; search_version: string }>(`
        SELECT id, knowledge_base_id, requester_id, question_hash, delivery_status,
          source_refs, search_version FROM hz_p5_answer_receipts
        WHERE tenant_id=$1 AND trace_id=$2`, [actor.tenantId, traceId])).rows[0]
      if (saved.knowledge_base_id !== kb || saved.requester_id !== actor.requesterId ||
        saved.question_hash !== questionHash || saved.delivery_status !== input.status ||
        saved.search_version !== searchVersion ||
        JSON.stringify(decoded<string[]>(saved.source_refs)) !== JSON.stringify(input.sourceRefs)) {
        throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '追踪编号对应不同交付')
      }
      return { receiptId: saved.id }
    })
  }

  async submit(context: UntrustedKnowledgeContext, input: { receiptId: string; idempotencyKey: string;
    category: FeedbackCategory; comment: string }): Promise<{ feedbackId: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const receiptId = required(input.receiptId, 'receiptId', 36)
    const key = required(input.idempotencyKey, 'idempotencyKey', 256)
    const comment = required(input.comment, 'comment', 1000)
    if (!categories.includes(input.category)) throw new KnowledgeError('INVALID_INPUT', '反馈分类无效')
    return this.database.transaction(async (tx) => {
      const receipt = (await tx.query<{ requester_id: string; knowledge_base_id: string }>(`
        SELECT requester_id, knowledge_base_id FROM hz_p5_answer_receipts
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, receiptId])).rows[0]
      if (!receipt || receipt.requester_id !== actor.requesterId) {
        throw new KnowledgeError('ACCESS_DENIED', '交付记录不可访问')
      }
      const inserted = (await tx.query<{ id: string }>(`INSERT INTO hz_p5_feedback
        (id, tenant_id, knowledge_base_id, receipt_id, idempotency_key, category, comment, submitted_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, receipt_id, idempotency_key) DO NOTHING RETURNING id`,
      [randomUUID(), actor.tenantId, receipt.knowledge_base_id, receiptId, key,
        input.category, comment, actor.requesterId])).rows[0]
      const saved = (await tx.query<{ id: string; category: string; comment: string }>(`
        SELECT id, category, comment FROM hz_p5_feedback
        WHERE tenant_id=$1 AND receipt_id=$2 AND idempotency_key=$3`,
      [actor.tenantId, receiptId, key])).rows[0]
      if (saved.category !== input.category || saved.comment !== comment) {
        throw new KnowledgeError('IDEMPOTENCY_CONFLICT', '反馈幂等键对应不同内容')
      }
      if (inserted) await audit(tx, actor.tenantId, actor.requesterId, context,
        'feedback.submitted', saved.id, input.category)
      return { feedbackId: saved.id }
    })
  }

  private async validateRefs(tx: SqlSession, tenantId: number, kb: string, refs: string[]) {
    if (!Array.isArray(refs) || refs.length > 16 || new Set(refs).size !== refs.length) {
      throw new KnowledgeError('INVALID_INPUT', '评测来源清单无效')
    }
    for (const sourceRef of refs) {
      const ref = reference(sourceRef)
      const exists = (await tx.query(`SELECT d.id FROM hz_documents d
        JOIN hz_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
        JOIN hz_builds b ON b.tenant_id=v.tenant_id AND b.version_id=v.id
        WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3 AND v.id=$4 AND b.id=$5`,
      [tenantId, kb, ref.documentId, ref.versionId, ref.buildId])).rows[0]
      if (!exists) throw new KnowledgeError('ACCESS_DENIED', '评测来源不可访问')
    }
  }

  async promoteToEvaluation(context: UntrustedKnowledgeContext, input: { feedbackId: string;
    question: string; expectedStatus: ExpectedStatus; requiredRefs: string[]; forbiddenRefs: string[];
    documentType: string; questionType: string; reason: string; asOf?: string }): Promise<{
      caseId: string; datasetRevision: number }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = required(input.feedbackId, 'feedbackId', 36)
    const question = required(input.question, 'question', 4000)
    const reason = required(input.reason, 'reason')
    const documentType = required(input.documentType, 'documentType', 40)
    const questionType = required(input.questionType, 'questionType', 40)
    if (!statuses.includes(input.expectedStatus) || !Array.isArray(input.requiredRefs) ||
      !Array.isArray(input.forbiddenRefs) ||
      input.expectedStatus === 'ok' && input.requiredRefs.length === 0 ||
      input.asOf !== undefined && (Number.isNaN(Date.parse(input.asOf)) || !input.asOf.endsWith('Z')) ||
      input.requiredRefs.some((ref) => input.forbiddenRefs.includes(ref))) {
      throw new KnowledgeError('INVALID_INPUT', '评测预期无效')
    }
    return this.database.transaction(async (tx) => {
      const feedback = (await tx.query<{ submitted_by: string; status: string;
        knowledge_base_id: string; question_hash: string }>(`SELECT f.submitted_by, f.status,
          f.knowledge_base_id, r.question_hash FROM hz_p5_feedback f
          JOIN hz_p5_answer_receipts r ON r.id=f.receipt_id
          WHERE f.tenant_id=$1 AND f.id=$2 FOR UPDATE`, [actor.tenantId, id])).rows[0]
      if (!feedback) throw new KnowledgeError('ACCESS_DENIED', '反馈不可访问')
      if (feedback.submitted_by === actor.requesterId) {
        throw new KnowledgeError('SELF_REVIEW_DENIED', '反馈提交人不能自行确认')
      }
      if (feedback.status !== 'pending') throw new KnowledgeError('REVIEW_CONFLICT', '反馈已处理')
      if (feedback.question_hash !== hash(question)) {
        throw new KnowledgeError('QUESTION_MISMATCH', '评测问题与原交付追踪不一致')
      }
      await this.validateRefs(tx, actor.tenantId, feedback.knowledge_base_id,
        [...input.requiredRefs, ...input.forbiddenRefs])
      await tx.query(`INSERT INTO hz_p5_dataset_state (tenant_id, knowledge_base_id)
        VALUES ($1,$2) ON CONFLICT (tenant_id, knowledge_base_id) DO NOTHING`,
      [actor.tenantId, feedback.knowledge_base_id])
      const revision = (await tx.query<{ revision: number }>(`UPDATE hz_p5_dataset_state
        SET revision=revision+1 WHERE tenant_id=$1 AND knowledge_base_id=$2 RETURNING revision`,
      [actor.tenantId, feedback.knowledge_base_id])).rows[0]
      const caseId = randomUUID()
      await tx.query(`INSERT INTO hz_p5_eval_cases
        (id, tenant_id, knowledge_base_id, dataset_revision, feedback_id, question,
         expected_status, required_refs, forbidden_refs, document_type, question_type, as_of, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
      [caseId, actor.tenantId, feedback.knowledge_base_id, revision.revision, id, question,
        input.expectedStatus, JSON.stringify(input.requiredRefs), JSON.stringify(input.forbiddenRefs),
        documentType, questionType, input.asOf ?? null, actor.requesterId])
      await tx.query(`UPDATE hz_p5_feedback SET status='promoted', reviewed_by=$3,
        review_reason=$4, reviewed_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, id, actor.requesterId, reason])
      await audit(tx, actor.tenantId, actor.requesterId, context, 'feedback.promoted', id, reason)
      return { caseId, datasetRevision: Number(revision.revision) }
    })
  }

  async reject(context: UntrustedKnowledgeContext, feedbackId: string, reason: string): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = required(feedbackId, 'feedbackId', 36)
    const explanation = required(reason, 'reason')
    await this.database.transaction(async (tx) => {
      const feedback = (await tx.query<{ submitted_by: string; status: string }>(`
        SELECT submitted_by, status FROM hz_p5_feedback WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [actor.tenantId, id])).rows[0]
      if (!feedback) throw new KnowledgeError('ACCESS_DENIED', '反馈不可访问')
      if (feedback.submitted_by === actor.requesterId) throw new KnowledgeError('SELF_REVIEW_DENIED', '不能自审')
      if (feedback.status !== 'pending') throw new KnowledgeError('REVIEW_CONFLICT', '反馈已处理')
      await tx.query(`UPDATE hz_p5_feedback SET status='rejected', reviewed_by=$3,
        review_reason=$4, reviewed_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, id, actor.requesterId, explanation])
      await audit(tx, actor.tenantId, actor.requesterId, context, 'feedback.rejected', id, explanation)
    })
  }
}
