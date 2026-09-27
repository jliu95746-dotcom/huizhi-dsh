import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type SqlSession, type UntrustedKnowledgeContext } from './foundation.js'

export const requiredPilotGates = [
  'G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09',
  'pilot_failures', 'quality_by_type', 'load_10', 'config_verified',
  'migration', 'backup_restore', 'rollback', 'alerts', 'training', 'ownership',
] as const
export type PilotGate = typeof requiredPilotGates[number]
export type PilotSignoffRole = 'business' | 'technical'

export interface FrozenPilotConfig {
  upstreamCommit: string
  pluginCommit: string
  pluginBundleSha256: string
  migrationId: string
  imageDigests: { app: string; docreader: string; postgres: string; redis: string }
  modelRevisions: { ocr: string; embedding: string; rerank: string; generation: string }
  profileHashes: { parsing: string; cleaning: string; chunking: string;
    retrieval: string; prompt: string }
}
export interface PilotEvidenceVerifier {
  verify(input: { reference: string; sha256: string; environment: 'staging' | 'production';
    gate: PilotGate; candidateId: string; configFingerprint: string }): Promise<boolean>
}
interface CandidateRow extends Record<string, unknown> {
  id: string; tenant_id: number; knowledge_base_id: string; proposal_id: string;
  evaluation_run_id: string; request_hash: string; dataset_revision: number;
  config_fingerprint: string; code_version: string; created_by: string
}
interface PilotReadiness { ready: boolean; missing: string[]; candidateId: string;
  configFingerprint: string; evidenceCount: number; signoffs: PilotSignoffRole[] }

const shaPattern = /^[a-f0-9]{64}$/i
const commitPattern = /^[a-f0-9]{40}$/i
function bounded(value: string, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
    /[\r\n\0]/.test(value)) throw new KnowledgeError('INVALID_INPUT', `${label} 无效`)
  return value.trim()
}
function sha(value: string, label: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    throw new KnowledgeError('INVALID_INPUT', `${label} 必须为 SHA-256`)
  }
  return value.toLowerCase()
}
function normalizedConfig(input: FrozenPilotConfig): FrozenPilotConfig {
  if (!input || typeof input !== 'object' ||
    !commitPattern.test(input.upstreamCommit) || !input.imageDigests ||
    !input.modelRevisions || !input.profileHashes) {
    throw new KnowledgeError('INVALID_INPUT', '候选配置无效')
  }
  return {
    upstreamCommit: input.upstreamCommit.toLowerCase(),
    pluginCommit: bounded(input.pluginCommit, 'pluginCommit', 128),
    pluginBundleSha256: sha(input.pluginBundleSha256, 'pluginBundleSha256'),
    migrationId: bounded(input.migrationId, 'migrationId', 128),
    imageDigests: {
      app: sha(input.imageDigests.app, 'WeKnora app image'),
      docreader: sha(input.imageDigests.docreader, 'WeKnora docreader image'),
      postgres: sha(input.imageDigests.postgres, 'PostgreSQL image'),
      redis: sha(input.imageDigests.redis, 'Redis image'),
    },
    modelRevisions: {
      ocr: bounded(input.modelRevisions.ocr, 'ocr model', 128),
      embedding: bounded(input.modelRevisions.embedding, 'embedding model', 128),
      rerank: bounded(input.modelRevisions.rerank, 'rerank model', 128),
      generation: bounded(input.modelRevisions.generation, 'generation model', 128),
    },
    profileHashes: {
      parsing: sha(input.profileHashes.parsing, 'parsing profile'),
      cleaning: sha(input.profileHashes.cleaning, 'cleaning profile'),
      chunking: sha(input.profileHashes.chunking, 'chunking profile'),
      retrieval: sha(input.profileHashes.retrieval, 'retrieval profile'),
      prompt: sha(input.profileHashes.prompt, 'prompt profile'),
    },
  }
}
export function fingerprintPilotConfig(config: FrozenPilotConfig): string {
  return createHash('sha256').update(JSON.stringify(normalizedConfig(config))).digest('hex')
}
async function audit(tx: SqlSession, context: UntrustedKnowledgeContext, tenantId: number,
  action: string, resourceId: string, reason: string): Promise<void> {
  await tx.query(`INSERT INTO hz_audit_events
    (id, tenant_id, actor_id, action, resource_type, resource_id, result, reason, trace_id)
    VALUES ($1,$2,$3,$4,'pilot_candidate',$5,'success',$6,$7)`,
  [randomUUID(), tenantId, context.requesterId, action, resourceId, reason, context.taskId ?? null])
}

export class KnowledgePilotAcceptance {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly evidenceVerifier: PilotEvidenceVerifier) {}

  private async candidate(tx: SqlSession, tenantId: number, candidateId: string,
    lock = false): Promise<CandidateRow> {
    const row = (await tx.query<CandidateRow>(`SELECT id, tenant_id, knowledge_base_id,
      proposal_id, evaluation_run_id, request_hash, dataset_revision, config_fingerprint,
      code_version, created_by FROM hz_p6_candidates WHERE tenant_id=$1 AND id=$2
      ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, candidateId])).rows[0]
    if (!row) throw new KnowledgeError('ACCESS_DENIED', '候选版本不可访问')
    return row
  }

  private async current(tx: SqlSession, candidate: CandidateRow): Promise<boolean> {
    const row = (await tx.query<{ status: string; request_hash: string;
      dataset_revision: number; config_fingerprint: string; code_version: string;
      approved_by: string | null; proposal_status: string; proposal_hash: string;
      current_revision: number }>(`SELECT e.status, e.request_hash, e.dataset_revision,
      e.config_fingerprint, e.code_version, e.approved_by,
      p.status AS proposal_status, p.request_hash AS proposal_hash,
      d.revision AS current_revision FROM hz_p5_eval_runs e
      JOIN hz_p4_release_proposals p ON p.id=e.proposal_id AND p.tenant_id=e.tenant_id
      JOIN hz_p5_dataset_state d ON d.tenant_id=e.tenant_id
        AND d.knowledge_base_id=e.knowledge_base_id
      WHERE e.tenant_id=$1 AND e.id=$2 AND e.proposal_id=$3
        AND e.knowledge_base_id=$4`,
    [candidate.tenant_id, candidate.evaluation_run_id, candidate.proposal_id,
      candidate.knowledge_base_id])).rows[0]
    return !!row && row.status === 'passed' && !!row.approved_by &&
      ['approved', 'published'].includes(row.proposal_status) &&
      row.request_hash === candidate.request_hash && row.proposal_hash === candidate.request_hash &&
      Number(row.dataset_revision) === Number(candidate.dataset_revision) &&
      Number(row.current_revision) === Number(candidate.dataset_revision) &&
      row.config_fingerprint === candidate.config_fingerprint &&
      row.code_version === candidate.code_version
  }

  async freeze(context: UntrustedKnowledgeContext, input: { proposalId: string;
    evaluationRunId: string; config: FrozenPilotConfig }): Promise<{
      candidateId: string; evaluationRunId: string; configFingerprint: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'publish')
    const proposalId = bounded(input.proposalId, 'proposalId', 36)
    const runId = bounded(input.evaluationRunId, 'evaluationRunId', 36)
    const config = normalizedConfig(input.config)
    const fingerprint = fingerprintPilotConfig(config)
    return this.database.transaction(async (tx) => {
      const proposal = (await tx.query<{ knowledge_base_id: string; request_hash: string; status: string }>(`
        SELECT knowledge_base_id, request_hash, status FROM hz_p4_release_proposals
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, proposalId])).rows[0]
      if (!proposal) throw new KnowledgeError('ACCESS_DENIED', '发布提案不可访问')
      if (proposal.status !== 'approved') throw new KnowledgeError('REVIEW_PENDING', '发布提案未批准')
      const run = (await tx.query<{ knowledge_base_id: string; request_hash: string;
        dataset_revision: number; config_fingerprint: string; code_version: string;
        status: string; approved_by: string | null }>(`SELECT knowledge_base_id, request_hash,
        dataset_revision, config_fingerprint, code_version, status, approved_by
        FROM hz_p5_eval_runs WHERE tenant_id=$1 AND id=$2 AND proposal_id=$3`,
      [actor.tenantId, runId, proposalId])).rows[0]
      const state = (await tx.query<{ revision: number }>(`SELECT revision FROM hz_p5_dataset_state
        WHERE tenant_id=$1 AND knowledge_base_id=$2 FOR UPDATE`,
      [actor.tenantId, proposal.knowledge_base_id])).rows[0]
      if (!run || run.status !== 'passed' || !run.approved_by ||
        run.knowledge_base_id !== proposal.knowledge_base_id ||
        run.request_hash !== proposal.request_hash ||
        Number(run.dataset_revision) !== Number(state?.revision)) {
        throw new KnowledgeError('EVALUATION_STALE', '没有当前发布提案的已批准评测')
      }
      if (run.config_fingerprint !== fingerprint || run.code_version !== config.pluginCommit) {
        throw new KnowledgeError('CONFIG_MISMATCH', '评测配置或代码版本与候选版本不一致')
      }
      const existing = (await tx.query<{ id: string }>(`SELECT id FROM hz_p6_candidates
        WHERE tenant_id=$1 AND proposal_id=$2`, [actor.tenantId, proposalId])).rows[0]
      if (existing) throw new KnowledgeError('CANDIDATE_EXISTS', '提案已有冻结候选版本')
      const id = randomUUID()
      await tx.query(`INSERT INTO hz_p6_candidates
        (id, tenant_id, knowledge_base_id, proposal_id, evaluation_run_id,
         request_hash, dataset_revision, config_fingerprint, code_version,
         frozen_config, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [id, actor.tenantId, proposal.knowledge_base_id, proposalId, runId,
        proposal.request_hash, run.dataset_revision, fingerprint, config.pluginCommit,
        JSON.stringify(config), actor.requesterId])
      await audit(tx, context, actor.tenantId, 'pilot.freeze', id, '候选配置冻结')
      return { candidateId: id, evaluationRunId: runId, configFingerprint: fingerprint }
    })
  }

  async attachEvidence(context: UntrustedKnowledgeContext, input: { candidateId: string;
    gate: PilotGate; reference: string; sha256: string;
    environment: 'staging' | 'production' }): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = bounded(input.candidateId, 'candidateId', 36)
    if (!requiredPilotGates.includes(input.gate) ||
      !['staging', 'production'].includes(input.environment)) {
      throw new KnowledgeError('INVALID_INPUT', '验收门槛或环境无效')
    }
    const reference = bounded(input.reference, 'reference', 256)
    const digest = sha(input.sha256, 'evidence sha256')
    const candidate = await this.candidate(this.database, actor.tenantId, id)
    if (!await this.current(this.database, candidate)) {
      throw new KnowledgeError('EVALUATION_STALE', '候选评测已失效')
    }
    let verified = false
    try {
      verified = await this.evidenceVerifier.verify({ reference, sha256: digest,
        environment: input.environment, gate: input.gate, candidateId: id,
        configFingerprint: candidate.config_fingerprint })
    } catch { /* 证据存储故障时拒绝留证，避免将外部错误文本写入日志或返回。 */ }
    if (!verified) {
      throw new KnowledgeError('EVIDENCE_UNVERIFIED', '验收证据未通过可信存储验证')
    }
    await this.database.transaction(async (tx) => {
      const locked = await this.candidate(tx, actor.tenantId, id, true)
      if (!await this.current(tx, locked)) {
        throw new KnowledgeError('EVALUATION_STALE', '候选评测已失效')
      }
      const signoff = (await tx.query<{ id: string }>(`SELECT id FROM hz_p6_signoffs
        WHERE tenant_id=$1 AND candidate_id=$2 LIMIT 1`, [actor.tenantId, id])).rows[0]
      if (signoff) throw new KnowledgeError('ACCEPTANCE_LOCKED', '已开始签认，证据不可追加')
      await tx.query(`INSERT INTO hz_p6_evidence
        (id, tenant_id, candidate_id, gate, reference, sha256, environment, verified_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), actor.tenantId, id, input.gate, reference, digest,
        input.environment, actor.requesterId])
      await audit(tx, context, actor.tenantId, 'pilot.evidence', id, input.gate)
    })
  }

  private async status(tx: SqlSession, candidate: CandidateRow): Promise<PilotReadiness> {
    const evidence = (await tx.query<{ gate: PilotGate; reference: string; sha256: string;
      environment: 'staging' | 'production' }>(`SELECT gate, reference, sha256, environment
      FROM hz_p6_evidence
      WHERE tenant_id=$1 AND candidate_id=$2`, [candidate.tenant_id, candidate.id])).rows
    const signoffs = (await tx.query<{ role: PilotSignoffRole; signed_by: string }>(`
      SELECT role, signed_by FROM hz_p6_signoffs WHERE tenant_id=$1 AND candidate_id=$2`,
    [candidate.tenant_id, candidate.id])).rows
    const gates = new Set<string>()
    for (const item of evidence) {
      try {
        if (await this.evidenceVerifier.verify({ reference: item.reference,
          sha256: item.sha256, environment: item.environment, gate: item.gate,
          candidateId: candidate.id, configFingerprint: candidate.config_fingerprint })) {
          gates.add(item.gate)
        }
      } catch { /* 证据存储不可验证时保持阻断，不报告为通过。 */ }
    }
    const missing: string[] = requiredPilotGates.filter((gate) => !gates.has(gate))
    if (!await this.current(tx, candidate)) missing.push('evaluation_current')
    const business = signoffs.find((item) => item.role === 'business')
    const technical = signoffs.find((item) => item.role === 'technical')
    if (!business) missing.push('business_signoff')
    if (!technical) missing.push('technical_signoff')
    if (business && technical && business.signed_by === technical.signed_by) {
      missing.push('independent_signoff')
    }
    return { ready: missing.length === 0, missing, candidateId: candidate.id,
      configFingerprint: candidate.config_fingerprint, evidenceCount: evidence.length,
      signoffs: signoffs.map((item) => item.role) }
  }

  async readiness(context: UntrustedKnowledgeContext, candidateId: string): Promise<PilotReadiness> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    if (!actor.permissions.includes('review') && !actor.permissions.includes('publish') &&
      !actor.permissions.includes('audit_read')) {
      throw new KnowledgeError('ACCESS_DENIED', '没有验收查看权限')
    }
    const candidate = await this.candidate(this.database, actor.tenantId,
      bounded(candidateId, 'candidateId', 36))
    return this.status(this.database, candidate)
  }

  async signOff(context: UntrustedKnowledgeContext, candidateId: string,
    role: PilotSignoffRole, reason: string): Promise<void> {
    const requiredPermission = role === 'business' ? 'pilot_business_signoff' : role === 'technical' ?
      'pilot_technical_signoff' : null
    if (!requiredPermission) throw new KnowledgeError('INVALID_INPUT', '签认角色无效')
    const actor = await verifyKnowledgeActor(context, this.identity, requiredPermission)
    const id = bounded(candidateId, 'candidateId', 36)
    const note = bounded(reason, 'reason', 512)
    await this.database.transaction(async (tx) => {
      const candidate = await this.candidate(tx, actor.tenantId, id, true)
      if (candidate.created_by === actor.requesterId) {
        throw new KnowledgeError('SELF_REVIEW_DENIED', '候选创建人不能签认')
      }
      const status = await this.status(tx, candidate)
      if (status.missing.some((item) => item !== 'business_signoff' &&
        item !== 'technical_signoff')) {
        throw new KnowledgeError('ACCEPTANCE_INCOMPLETE', '验收证据不完整或评测已失效')
      }
      const other = role === 'business' ? 'technical' : 'business'
      const existing = (await tx.query<{ role: PilotSignoffRole; signed_by: string }>(`
        SELECT role, signed_by FROM hz_p6_signoffs WHERE tenant_id=$1 AND candidate_id=$2`,
      [actor.tenantId, id])).rows
      if (existing.some((item) => item.role === role)) {
        throw new KnowledgeError('SIGNOFF_EXISTS', '该角色已经签认')
      }
      if (existing.some((item) => item.role === other && item.signed_by === actor.requesterId)) {
        throw new KnowledgeError('SELF_REVIEW_DENIED', '业务与技术签认必须由不同人员完成')
      }
      await tx.query(`INSERT INTO hz_p6_signoffs
        (id, tenant_id, candidate_id, role, signed_by, reason)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), actor.tenantId, id, role, actor.requesterId, note])
      await audit(tx, context, actor.tenantId, 'pilot.signoff', id, role)
    })
  }
}
