import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeGovernance } from '../src/knowledge/governance.js'
import { KnowledgeFeedback } from '../src/knowledge/feedback.js'
import { KnowledgeEvaluation } from '../src/knowledge/evaluation.js'
import { KnowledgePilotAcceptance, requiredPilotGates, fingerprintPilotConfig,
  type FrozenPilotConfig } from '../src/knowledge/pilot-acceptance.js'

const actors: Record<string, VerifiedKnowledgeActor> = {
  owner: { tenantId: 7, organizationId: 'org', requesterId: 'owner',
    principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish'] },
  evaluator: { tenantId: 7, organizationId: 'org', requesterId: 'evaluator',
    principals: [{ type: 'user', id: 'evaluator' }], permissions: ['review'] },
  reviewer: { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] },
  business: { tenantId: 7, organizationId: 'org', requesterId: 'business',
    principals: [{ type: 'user', id: 'business' }],
    permissions: ['review', 'pilot_business_signoff'] },
  tech: { tenantId: 7, organizationId: 'org', requesterId: 'tech',
    principals: [{ type: 'user', id: 'tech' }],
    permissions: ['publish', 'pilot_technical_signoff'] },
  outsider: { tenantId: 8, organizationId: 'other', requesterId: 'outsider',
    principals: [{ type: 'user', id: 'outsider' }], permissions: ['review', 'publish'] },
}
const identity = { verify: async (input: { serviceCredential: string }) => {
  const actor = actors[input.serviceCredential]
  if (!actor) throw new Error('invalid credential')
  return actor
} }
const context = (who: keyof typeof actors) => ({ serviceCredential: who,
  organizationId: actors[who].organizationId, requesterId: who, taskId: `trace-${who}` })
const hash = 'a'.repeat(64)
const config: FrozenPilotConfig = {
  upstreamCommit: '3e8b0bfc80b845b2d4b2ed683994748741450a97',
  pluginCommit: 'candidate-code-1', pluginBundleSha256: hash,
  migrationId: '0005_p6_pilot_acceptance',
  imageDigests: { app: hash, docreader: hash, postgres: hash, redis: hash },
  modelRevisions: { ocr: 'ocr-v1', embedding: 'embed-v1', rerank: 'rerank-v1',
    generation: 'dsh-v1' },
  profileHashes: { parsing: hash, cleaning: hash, chunking: hash,
    retrieval: hash, prompt: hash },
}

async function fixture(t: TestContext) {
  const db = await PGlite.create()
  t.after(async () => db.close())
  for (const migration of ['0001_p1_foundation', '0002_p2_staged_index',
    '0003_p4_governance', '0004_p5_feedback_operations', '0005_p6_pilot_acceptance']) {
    await db.exec(await readFile(resolve('plugins/knowledge/migrations', `${migration}.up.sql`), 'utf8'))
  }
  const sql: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
      ({ rows: (await db.query<Row>(query, params)).rows }),
    transaction: (work) => db.transaction(async (tx) => work({
      query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
        ({ rows: (await tx.query<Row>(query, params)).rows }),
    })),
  }
  const foundation = new KnowledgeFoundation(sql, identity, { verify: async () => true },
    () => new Date('2026-09-27T12:00:00Z'))
  const governance = new KnowledgeGovernance(sql, identity, foundation, { loadText: async () => null },
    () => new Date('2026-09-27T12:00:00Z'))
  const feedback = new KnowledgeFeedback(sql, identity, foundation)
  const evaluation = new KnowledgeEvaluation(sql, identity)
  let evidenceAvailable = true
  const acceptance = new KnowledgePilotAcceptance(sql, identity, { verify: async (input) =>
    evidenceAvailable && input.reference.startsWith('vault:') && input.sha256 === hash &&
    input.environment === 'staging' })
  const version = await foundation.registerVersion(context('owner'), { knowledgeBaseId: 'kb',
    sourceSystem: 'test', sourceDocumentId: 'policy', sourceRevision: 'v1',
    contentHash: hash, objectRef: 'private://policy-v1' })
  const build = await foundation.startBuild(context('owner'), { versionId: version.versionId,
    pipelineFingerprint: 'p1', idempotencyKey: 'build-1' })
  await foundation.completeBuild(context('owner'), { runId: build.runId, generation: build.generation })
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'release-1', reason: '发布制度',
    entries: [{ ...version, buildId: build.buildId,
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }] })
  return { db, sql, foundation, governance, feedback, evaluation, acceptance, proposal,
    setEvidenceAvailable: (available: boolean) => { evidenceAvailable = available } }
}

async function approvedCandidate(t: TestContext) {
  const services = await fixture(t)
  const { sql, evaluation, governance, acceptance, proposal } = services
  // 测试集只含合成无答案题，不能用作真实 P6 验收证据。
  await sql.query(`INSERT INTO hz_p5_dataset_state (tenant_id, knowledge_base_id, revision)
    VALUES (7,'kb',1)`)
  await sql.query(`INSERT INTO hz_p5_answer_receipts
    (id, tenant_id, knowledge_base_id, trace_id, requester_id, question_hash,
     delivery_status, source_refs, search_version)
    VALUES ('receipt',7,'kb','t','employee',$1,'rejected','[]','none')`, [hash])
  await sql.query(`INSERT INTO hz_p5_feedback
    (id, tenant_id, knowledge_base_id, receipt_id, idempotency_key, category,
     comment, submitted_by, status)
    VALUES ('feedback',7,'kb','receipt','fb','missing_document','test','employee','promoted')`)
  await sql.query(`INSERT INTO hz_p5_eval_cases
    (id, tenant_id, knowledge_base_id, dataset_revision, feedback_id, question,
     expected_status, required_refs, forbidden_refs, document_type, question_type, created_by)
    VALUES ('case',7,'kb',1,'feedback','有制度吗？','no_evidence','[]','[]','policy','no_answer','reviewer')`)
  const run = await evaluation.runProposal(context('evaluator'), { proposalId: proposal.proposalId,
    configFingerprint: fingerprintPilotConfig(config), codeVersion: config.pluginCommit,
    runner: async () => ({ status: 'no_evidence', sourceRefs: [], durationMs: 1, costMicros: 0 }) })
  await evaluation.approveRun(context('reviewer'), run.runId, '合成路径已复核')
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '批准候选')
  const candidate = await acceptance.freeze(context('owner'), { proposalId: proposal.proposalId,
    evaluationRunId: run.runId, config })
  return { ...services, candidate }
}

test('P6 候选冻结只接受当前已批准评测与对应配置，不能凭自报配置跳过', async (t) => {
  const { acceptance, candidate, db, proposal } = await approvedCandidate(t)
  assert.equal((await acceptance.readiness(context('business'), candidate.candidateId)).ready, false)
  assert.deepEqual((await acceptance.readiness(context('business'), candidate.candidateId)).missing,
    [...requiredPilotGates, 'business_signoff', 'technical_signoff'])
  await assert.rejects(acceptance.readiness(context('outsider'), candidate.candidateId),
    { code: 'ACCESS_DENIED' })
  await assert.rejects(acceptance.freeze(context('owner'), { proposalId: proposal.proposalId,
    evaluationRunId: candidate.evaluationRunId, config: { ...config, pluginCommit: 'different' } }),
  { code: 'CONFIG_MISMATCH' })
  await assert.rejects(db.query(`UPDATE hz_p6_candidates SET config_fingerprint='forged' WHERE id=$1`,
    [candidate.candidateId]), /immutable record: hz_p6_candidates/i)
})

test('P6 证据须经可信验证；九项硬条件、试点与恢复等齐全后由不同人员签认', async (t) => {
  const { acceptance, candidate, sql, setEvidenceAvailable } = await approvedCandidate(t)
  await assert.rejects(acceptance.attachEvidence(context('reviewer'), {
    candidateId: candidate.candidateId, gate: 'G-01', reference: 'self-asserted',
    sha256: hash, environment: 'staging' }), { code: 'EVIDENCE_UNVERIFIED' })
  await assert.rejects(acceptance.signOff(context('business'), candidate.candidateId,
    'business', '先签'), { code: 'ACCEPTANCE_INCOMPLETE' })
  for (const gate of requiredPilotGates) {
    await acceptance.attachEvidence(context('reviewer'), { candidateId: candidate.candidateId,
      gate, reference: `vault:${gate}`, sha256: hash, environment: 'staging' })
  }
  await assert.rejects(acceptance.signOff(context('reviewer'), candidate.candidateId,
    'business', '通用审核人不能代签'), { code: 'ACCESS_DENIED' })
  await acceptance.signOff(context('business'), candidate.candidateId, 'business', '业务试点已核验')
  await assert.rejects(acceptance.attachEvidence(context('reviewer'), {
    candidateId: candidate.candidateId, gate: 'G-01', reference: 'vault:replacement',
    sha256: hash, environment: 'staging' }), { code: 'ACCEPTANCE_LOCKED' })
  await assert.rejects(acceptance.signOff(context('business'), candidate.candidateId,
    'technical', '代签'), { code: 'ACCESS_DENIED' })
  await acceptance.signOff(context('tech'), candidate.candidateId, 'technical', '技术证据已核验')
  const ready = await acceptance.readiness(context('business'), candidate.candidateId)
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.missing, [])
  setEvidenceAvailable(false)
  const unavailable = await acceptance.readiness(context('business'), candidate.candidateId)
  assert.equal(unavailable.ready, false)
  assert.ok(unavailable.missing.includes('G-09'))
  setEvidenceAvailable(true)
  await sql.query(`UPDATE hz_p5_dataset_state SET revision=2 WHERE tenant_id=7 AND knowledge_base_id='kb'`)
  const stale = await acceptance.readiness(context('business'), candidate.candidateId)
  assert.equal(stale.ready, false)
  assert.ok(stale.missing.includes('evaluation_current'))
})

test('P6 迁移回退保留 P1～P5 数据表', async (t) => {
  const { db } = await fixture(t)
  await db.exec(await readFile(resolve('plugins/knowledge/migrations',
    '0005_p6_pilot_acceptance.down.sql'), 'utf8'))
  const result = (await db.query<{ p5: string; p6: string | null }>(`
    SELECT to_regclass('hz_p5_eval_runs')::text AS p5,
      to_regclass('hz_p6_candidates')::text AS p6`)).rows[0]
  assert.equal(result.p5, 'hz_p5_eval_runs')
  assert.equal(result.p6, null)
})
