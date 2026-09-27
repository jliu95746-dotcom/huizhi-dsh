import { randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type ReleaseEntry, type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'
import type { ExpectedStatus } from './feedback.js'

interface EvaluationCase extends Record<string, unknown> { id: string; question: string; expected_status: ExpectedStatus;
  required_refs: string[] | string; forbidden_refs: string[] | string;
  document_type: string; question_type: string; as_of: string | null }
export interface EvaluationRunner {
  (input: { question: string; asOf: string | null; proposalEntries: ReleaseEntry[];
    configFingerprint: string }): Promise<{ status: ExpectedStatus; sourceRefs: string[];
      durationMs: number; costMicros: number }>
}
interface CaseResult { caseId: string; passed: boolean; actualStatus: string;
  documentType: string; questionType: string; durationMs: number; costMicros: number }
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
const nonempty = (value: string, name: string, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 无效`)
  }
  return value.trim()
}

export class KnowledgeEvaluation {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier) {}

  async runProposal(context: UntrustedKnowledgeContext, input: { proposalId: string;
    configFingerprint: string; codeVersion: string; runner: EvaluationRunner }): Promise<{
      runId: string; status: 'passed' | 'failed'; caseCount: number; datasetRevision: number }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const proposalId = nonempty(input.proposalId, 'proposalId', 36)
    const config = nonempty(input.configFingerprint, 'configFingerprint')
    const code = nonempty(input.codeVersion, 'codeVersion', 128)
    if (typeof input.runner !== 'function') throw new KnowledgeError('INVALID_INPUT', '评测执行器缺失')
    const proposal = (await this.database.query<{ knowledge_base_id: string; request_hash: string;
      entries: ReleaseEntry[] | string; status: string }>(`SELECT knowledge_base_id, request_hash,
      entries, status FROM hz_p4_release_proposals WHERE tenant_id=$1 AND id=$2`,
    [actor.tenantId, proposalId])).rows[0]
    if (!proposal) throw new KnowledgeError('ACCESS_DENIED', '发布提案不可访问')
    if (!['draft', 'approved'].includes(proposal.status)) {
      throw new KnowledgeError('REVIEW_CONFLICT', '发布提案不可评测')
    }
    const state = (await this.database.query<{ revision: number }>(`SELECT revision FROM hz_p5_dataset_state
      WHERE tenant_id=$1 AND knowledge_base_id=$2`,
    [actor.tenantId, proposal.knowledge_base_id])).rows[0]
    if (!state || Number(state.revision) < 1) throw new KnowledgeError('EMPTY_DATASET', '评测集为空')
    const revision = Number(state.revision)
    const cases = (await this.database.query<EvaluationCase>(`SELECT id, question, expected_status,
      required_refs, forbidden_refs, document_type, question_type, as_of
      FROM hz_p5_eval_cases WHERE tenant_id=$1 AND knowledge_base_id=$2
        AND dataset_revision <= $3 ORDER BY dataset_revision, id LIMIT 501`,
    [actor.tenantId, proposal.knowledge_base_id, revision])).rows
    if (!cases.length || cases.length > 500) throw new KnowledgeError('DATASET_SIZE_INVALID', '评测样本数量无效')
    const results: CaseResult[] = []
    for (const item of cases) {
      let actualStatus = 'runner_error'
      let passed = false
      let durationMs = 0
      let costMicros = 0
      try {
        const result = await input.runner({ question: item.question,
          asOf: item.as_of === null ? null : new Date(item.as_of).toISOString(),
          proposalEntries: decode<ReleaseEntry[]>(proposal.entries), configFingerprint: config })
        const valid = ['ok', 'no_evidence', 'needs_clarification', 'unresolved_conflict', 'degraded'].includes(result.status) &&
          Array.isArray(result.sourceRefs) && result.sourceRefs.length <= 16 &&
          result.sourceRefs.every((ref) => typeof ref === 'string' &&
            /^knowledge:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(ref)) &&
          (result.status !== 'ok' || result.sourceRefs.length > 0) &&
          Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 &&
          Number.isSafeInteger(result.costMicros) && result.costMicros >= 0
        if (valid) {
          actualStatus = result.status
          durationMs = result.durationMs
          costMicros = result.costMicros
          const refs = new Set(result.sourceRefs)
          passed = result.status === item.expected_status &&
            decode<string[]>(item.required_refs).every((ref) => refs.has(ref)) &&
            decode<string[]>(item.forbidden_refs).every((ref) => !refs.has(ref))
        }
      } catch { /* Provider or runner failures fail the case without storing sensitive error text. */ }
      results.push({ caseId: item.id, passed, actualStatus, documentType: item.document_type,
        questionType: item.question_type, durationMs, costMicros })
    }
    const status = results.every((item) => item.passed) ? 'passed' : 'failed'
    const runId = randomUUID()
    await this.database.transaction(async (tx) => {
      const latest = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_p5_dataset_state
        WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`,
      [actor.tenantId, proposal.knowledge_base_id])).rows[0]
      const currentProposal = (await tx.query<{ request_hash: string; status: string }>(`
        SELECT request_hash, status FROM hz_p4_release_proposals WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, proposalId])).rows[0]
      if (Number(latest?.revision) !== revision || currentProposal?.request_hash !== proposal.request_hash ||
        !['draft', 'approved'].includes(currentProposal.status)) {
        throw new KnowledgeError('DATASET_CHANGED', '评测期间数据集或提案已变化')
      }
      await tx.query(`INSERT INTO hz_p5_eval_runs
        (id, tenant_id, knowledge_base_id, proposal_id, request_hash, dataset_revision,
         config_fingerprint, code_version, status, case_count, results, run_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [runId, actor.tenantId, proposal.knowledge_base_id, proposalId, proposal.request_hash,
        revision, config, code, status, results.length, JSON.stringify(results), actor.requesterId])
    })
    return { runId, status, caseCount: results.length, datasetRevision: revision }
  }

  async approveRun(context: UntrustedKnowledgeContext, runId: string, reason: string): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = nonempty(runId, 'runId', 36)
    const explanation = nonempty(reason, 'reason', 512)
    await this.database.transaction(async (tx) => {
      const run = (await tx.query<{ proposal_id: string; knowledge_base_id: string;
        dataset_revision: number; status: string; run_by: string; approved_by: string | null }>(`
        SELECT proposal_id, knowledge_base_id, dataset_revision, status, run_by, approved_by
        FROM hz_p5_eval_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [actor.tenantId, id])).rows[0]
      if (!run) throw new KnowledgeError('ACCESS_DENIED', '评测运行不可访问')
      if (run.status !== 'passed') throw new KnowledgeError('EVALUATION_FAILED', '未通过评测不能批准')
      const proposal = (await tx.query<{ proposed_by: string; status: string }>(`
        SELECT proposed_by, status FROM hz_p4_release_proposals WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, run.proposal_id])).rows[0]
      if (run.run_by === actor.requesterId || proposal.proposed_by === actor.requesterId) {
        throw new KnowledgeError('SELF_REVIEW_DENIED', '评测执行人或提案人不能批准自身结果')
      }
      if (run.approved_by || !['draft', 'approved'].includes(proposal.status)) {
        throw new KnowledgeError('REVIEW_CONFLICT', '评测运行已批准或提案状态已变化')
      }
      const state = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_p5_dataset_state
        WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`,
      [actor.tenantId, run.knowledge_base_id])).rows[0]
      if (Number(state?.revision) !== Number(run.dataset_revision)) {
        throw new KnowledgeError('DATASET_CHANGED', '评测集版本已变化')
      }
      await tx.query(`UPDATE hz_p5_eval_runs SET approved_by=$3, approval_reason=$4,
        approved_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, id, actor.requesterId, explanation])
      await tx.query(`INSERT INTO hz_audit_events
        (id, tenant_id, actor_id, action, resource_type, resource_id, result, reason, trace_id)
        VALUES ($1,$2,$3,'evaluation.approved','evaluation',$4,'success',$5,$6)`,
      [randomUUID(), actor.tenantId, actor.requesterId, id, explanation, context.taskId ?? null])
    })
  }

  async compareRuns(context: UntrustedKnowledgeContext, firstRunId: string, secondRunId: string): Promise<{
    before: { passed: number; total: number; costMicros: number }; after: { passed: number; total: number; costMicros: number };
    changedCaseIds: string[] }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const rows = (await this.database.query<{ id: string; knowledge_base_id: string; results: CaseResult[] | string }>(`
      SELECT id, knowledge_base_id, results FROM hz_p5_eval_runs
      WHERE tenant_id=$1 AND id IN ($2,$3)`,
    [actor.tenantId, nonempty(firstRunId, 'firstRunId', 36),
      nonempty(secondRunId, 'secondRunId', 36)])).rows
    const first = rows.find((row) => row.id === firstRunId)
    const second = rows.find((row) => row.id === secondRunId)
    if (!first || !second || first.knowledge_base_id !== second.knowledge_base_id) {
      throw new KnowledgeError('ACCESS_DENIED', '评测运行不可比较')
    }
    const before = decode<CaseResult[]>(first.results)
    const after = decode<CaseResult[]>(second.results)
    const summary = (items: CaseResult[]) => ({ passed: items.filter((item) => item.passed).length,
      total: items.length, costMicros: items.reduce((sum, item) => sum + item.costMicros, 0) })
    const previous = new Map(before.map((item) => [item.caseId, item]))
    return { before: summary(before), after: summary(after),
      changedCaseIds: after.filter((item) => previous.get(item.caseId)?.passed !== item.passed)
        .map((item) => item.caseId) }
  }
}
