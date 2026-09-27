import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeGovernance } from '../src/knowledge/governance.js'
import { KnowledgeFeedback } from '../src/knowledge/feedback.js'
import { KnowledgeEvaluation } from '../src/knowledge/evaluation.js'

const actors: Record<string, VerifiedKnowledgeActor> = {
  owner: { tenantId: 7, organizationId: 'org', requesterId: 'owner',
    principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish', 'manage_acl', 'revoke'] },
  evaluator: { tenantId: 7, organizationId: 'org', requesterId: 'evaluator',
    principals: [{ type: 'user', id: 'evaluator' }], permissions: ['review'] },
  reviewer: { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] },
  alice: { tenantId: 7, organizationId: 'org', requesterId: 'alice',
    principals: [{ type: 'user', id: 'alice' }], permissions: [] },
  delivery: { tenantId: 7, organizationId: 'org', requesterId: 'alice',
    principals: [{ type: 'user', id: 'alice' }], permissions: ['record_delivery'] },
}
const identity = { verify: async (input: { serviceCredential: string }) => {
  const actor = actors[input.serviceCredential]
  if (!actor) throw new Error('invalid credential')
  return actor
} }
const context = (who: keyof typeof actors) => ({ serviceCredential: who, organizationId: 'org',
  requesterId: who === 'delivery' ? 'alice' : who, taskId: `trace-${who}` })

async function fixture(t: TestContext) {
  const db = await PGlite.create()
  t.after(async () => db.close())
  for (const migration of ['0001_p1_foundation.up.sql', '0002_p2_staged_index.up.sql',
    '0003_p4_governance.up.sql', '0004_p5_feedback_operations.up.sql']) {
    await db.exec(await readFile(resolve('plugins/knowledge/migrations', migration), 'utf8'))
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
  const version = await foundation.registerVersion(context('owner'), { knowledgeBaseId: 'kb',
    sourceSystem: 'test', sourceDocumentId: 'policy', sourceRevision: 'v1',
    contentHash: 'a'.repeat(64), objectRef: 'private://policy-v1' })
  const build = await foundation.startBuild(context('owner'), { versionId: version.versionId,
    pipelineFingerprint: 'p1', idempotencyKey: 'build-1' })
  await foundation.completeBuild(context('owner'), { runId: build.runId, generation: build.generation })
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'release-1', reason: '发布制度',
    entries: [{ ...version, buildId: build.buildId,
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }] })
  return { db, foundation, governance, feedback, evaluation, proposal }
}

test('反馈绑定实际交付追踪，跨人提交及自审拒绝，人工转为版本化评测样本', async (t) => {
  const { db, feedback } = await fixture(t)
  await assert.rejects(feedback.recordDelivery(context('alice'), { knowledgeBaseId: 'kb',
    traceId: 'forged', question: '伪造', status: 'rejected', sourceRefs: [], searchVersion: 'none' }),
  { code: 'ACCESS_DENIED' })
  const receipt = await feedback.recordDelivery(context('delivery'), { knowledgeBaseId: 'kb',
    traceId: 'question-1', question: '当前有住宿标准吗？', status: 'rejected',
    sourceRefs: [], searchVersion: 'none' })
  await assert.rejects(feedback.submit(context('owner'), { receiptId: receipt.receiptId,
    idempotencyKey: 'feedback-1', category: 'missing_document', comment: '缺少现行制度' }),
  { code: 'ACCESS_DENIED' })
  const submitted = await feedback.submit(context('alice'), { receiptId: receipt.receiptId,
    idempotencyKey: 'feedback-1', category: 'missing_document', comment: '缺少现行制度' })
  assert.equal((await feedback.submit(context('alice'), { receiptId: receipt.receiptId,
    idempotencyKey: 'feedback-1', category: 'missing_document', comment: '缺少现行制度' })).feedbackId,
  submitted.feedbackId)
  await assert.rejects(feedback.promoteToEvaluation(context('alice'), { feedbackId: submitted.feedbackId,
    question: '当前有住宿标准吗？', expectedStatus: 'no_evidence', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'no_answer', reason: '核对' }), { code: 'ACCESS_DENIED' })
  await assert.rejects(feedback.promoteToEvaluation(context('reviewer'), { feedbackId: submitted.feedbackId,
    question: '另一个问题', expectedStatus: 'no_evidence', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'no_answer', reason: '核对' }), { code: 'QUESTION_MISMATCH' })
  await assert.rejects(feedback.promoteToEvaluation(context('reviewer'), { feedbackId: submitted.feedbackId,
    question: '当前有住宿标准吗？', expectedStatus: 'ok', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'fact', reason: '无证据仍想通过' }), { code: 'INVALID_INPUT' })
  const sample = await feedback.promoteToEvaluation(context('reviewer'), { feedbackId: submitted.feedbackId,
    question: '当前有住宿标准吗？', expectedStatus: 'no_evidence', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'no_answer', reason: '确认为无答案样本' })
  assert.equal(sample.datasetRevision, 1)
  const row = (await db.query<{ question_hash: string }>(`SELECT question_hash FROM hz_p5_answer_receipts
    WHERE id=$1`, [receipt.receiptId])).rows[0]
  assert.equal(row.question_hash.length, 64)
})

test('评测通过且独立复核后才能批准发布；评测集更新使旧批准失效', async (t) => {
  const { db, governance, feedback, evaluation, proposal } = await fixture(t)
  await assert.rejects(governance.approveRelease(context('reviewer'), proposal.proposalId, '先发布'),
    /evaluation approval required/i)
  const receipt = await feedback.recordDelivery(context('delivery'), { knowledgeBaseId: 'kb',
    traceId: 'question-1', question: '当前有住宿标准吗？', status: 'rejected',
    sourceRefs: [], searchVersion: 'none' })
  const submitted = await feedback.submit(context('alice'), { receiptId: receipt.receiptId,
    idempotencyKey: 'fb-1', category: 'missing_document', comment: '资料不足' })
  await feedback.promoteToEvaluation(context('reviewer'), { feedbackId: submitted.feedbackId,
    question: '当前有住宿标准吗？', expectedStatus: 'no_evidence', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'no_answer', reason: '经人工确认' })
  const failed = await evaluation.runProposal(context('evaluator'), { proposalId: proposal.proposalId,
    configFingerprint: 'cfg-1', codeVersion: 'commit-1',
    runner: async () => ({ status: 'ok', sourceRefs: [], durationMs: 10, costMicros: 0 }) })
  assert.equal(failed.status, 'failed')
  await assert.rejects(evaluation.approveRun(context('reviewer'), failed.runId, '误批'),
  { code: 'EVALUATION_FAILED' })
  const passed = await evaluation.runProposal(context('evaluator'), { proposalId: proposal.proposalId,
    configFingerprint: 'cfg-1', codeVersion: 'commit-1',
    runner: async () => ({ status: 'no_evidence', sourceRefs: [], durationMs: 10, costMicros: 0 }) })
  assert.equal(passed.status, 'passed')
  const comparison = await evaluation.compareRuns(context('reviewer'), failed.runId, passed.runId)
  assert.equal(comparison.before.passed, 0)
  assert.equal(comparison.after.passed, 1)
  assert.equal(comparison.changedCaseIds.length, 1)
  await assert.rejects(evaluation.approveRun(context('evaluator'), passed.runId, '自己批'),
  { code: 'SELF_REVIEW_DENIED' })
  await evaluation.approveRun(context('reviewer'), passed.runId, '无答案路径通过')
  await assert.rejects(db.query(`UPDATE hz_p5_eval_runs SET status='failed' WHERE id=$1`,
    [passed.runId]), /immutable evaluation run/i)
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '评测及制度已复核')
  const secondReceipt = await feedback.recordDelivery(context('delivery'), { knowledgeBaseId: 'kb',
    traceId: 'question-2', question: '是否允许超额？', status: 'rejected',
    sourceRefs: [], searchVersion: 'none' })
  const secondFeedback = await feedback.submit(context('alice'), { receiptId: secondReceipt.receiptId,
    idempotencyKey: 'fb-2', category: 'conflict', comment: '需要冲突题' })
  await feedback.promoteToEvaluation(context('reviewer'), { feedbackId: secondFeedback.feedbackId,
    question: '是否允许超额？', expectedStatus: 'unresolved_conflict', requiredRefs: [], forbiddenRefs: [],
    documentType: 'policy', questionType: 'conflict', reason: '经人工确认' })
  await assert.rejects(governance.publishApproved(context('owner'), proposal.proposalId),
    /evaluation approval required/i)
})

test('P5 迁移回退不影响 P1～P4 基础记录', async (t) => {
  const { db } = await fixture(t)
  await db.exec(await readFile(resolve('plugins/knowledge/migrations/0004_p5_feedback_operations.down.sql'), 'utf8'))
  assert.equal((await db.query<{ name: string }>(`SELECT to_regclass('hz_p4_release_proposals')::text AS name`)).rows[0].name,
    'hz_p4_release_proposals')
  assert.equal((await db.query<{ name: string | null }>(`SELECT to_regclass('hz_p5_feedback')::text AS name`)).rows[0].name,
    null)
})
