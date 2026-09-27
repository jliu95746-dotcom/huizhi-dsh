import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeGovernance } from '../src/knowledge/governance.js'

const actors: Record<string, VerifiedKnowledgeActor> = {
  owner: { tenantId: 7, organizationId: 'org', requesterId: 'owner',
    principals: [{ type: 'user', id: 'owner' }], permissions: ['ingest', 'publish', 'manage_acl', 'revoke'] },
  reviewer: { tenantId: 7, organizationId: 'org', requesterId: 'reviewer',
    principals: [{ type: 'user', id: 'reviewer' }], permissions: ['review'] },
  alice: { tenantId: 7, organizationId: 'org', requesterId: 'alice',
    principals: [{ type: 'user', id: 'alice' }], permissions: ['read_history'] },
}
const identity = { verify: async (context: { serviceCredential: string }) => {
  const actor = actors[context.serviceCredential]
  if (!actor) throw new Error('invalid service identity')
  return actor
} }
const context = (who: keyof typeof actors) => ({ serviceCredential: who,
  organizationId: 'org', requesterId: who, taskId: `task-${who}` })

async function fixture(t: TestContext) {
  const db = await PGlite.create()
  t.after(async () => db.close())
  for (const migration of ['0001_p1_foundation.up.sql', '0002_p2_staged_index.up.sql',
    '0003_p4_governance.up.sql']) {
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
  const originals = new Map<string, string>()
  const governance = new KnowledgeGovernance(sql, identity, foundation, {
    loadText: async (ref) => originals.get(ref) ?? null,
  })
  const prepare = async (revision: string) => {
    const version = await foundation.registerVersion(context('owner'), { knowledgeBaseId: 'kb',
      sourceSystem: 'test', sourceDocumentId: 'policy', sourceRevision: revision,
      contentHash: revision.repeat(64).slice(0, 64), objectRef: `private://${revision}` })
    const run = await foundation.startBuild(context('owner'), { versionId: version.versionId,
      pipelineFingerprint: `pipeline-${revision}`, idempotencyKey: `build-${revision}` })
    await foundation.completeBuild(context('owner'), { runId: run.runId, generation: run.generation })
    return { ...version, buildId: run.buildId }
  }
  return { db, foundation, governance, originals, prepare }
}

test('审核审批是发布硬闸门；直接调用 P1 发布不能绕过审批', async (t) => {
  const { db, foundation, governance, prepare } = await fixture(t)
  const version = await prepare('a')
  const entries = [{ ...version, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }]
  await assert.rejects(foundation.publish(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'release-a', entries }), /governance approval required/i)
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'release-a', entries, reason: '制度首次发布' })
  assert.equal(proposal.preview.added.length, 1)
  await assert.rejects(governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'release-a', entries,
    reason: '制度首次发布', publishNotBefore: '2099-01-01T00:00:00Z' }),
  { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(governance.approveRelease(context('owner'), proposal.proposalId, '同意'), { code: 'ACCESS_DENIED' })
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '已核对原文和有效期')
  const published = await governance.publishApproved(context('owner'), proposal.proposalId)
  assert.ok(published.releaseId)
  assert.equal((await governance.publishApproved(context('owner'), proposal.proposalId)).releaseId, published.releaseId)
  const count = (await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_releases')).rows[0].count
  assert.equal(count, 1)
})

test('近重复关键差异只能保留双方；未裁决冲突阻止发布审批', async (t) => {
  const { governance, originals, prepare } = await fixture(t)
  const a = await prepare('a')
  const b = await prepare('b')
  const leftRef = `knowledge:${a.documentId}:${a.versionId}:${a.buildId}:chunkA`
  const rightRef = `knowledge:${b.documentId}:${b.versionId}:${b.buildId}:chunkB`
  originals.set(leftRef, '住宿上限500元，不得超额。')
  originals.set(rightRef, '住宿上限800元，可以超额。')
  const review = await governance.createReviewCase(context('owner'), { knowledgeBaseId: 'kb', kind: 'duplicate',
    leftRef, rightRef, reason: '近重复候选' })
  await assert.rejects(governance.decideReviewCase(context('reviewer'), { caseId: review.caseId,
    expectedRevision: 1, action: 'mark_duplicate', reason: '看起来相似' }), { code: 'DUPLICATE_CRITICAL_DIFFERENCE' })
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'release-b', entries: [{ ...b, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
    reason: '拟发布新制度' })
  await assert.rejects(governance.approveRelease(context('reviewer'), proposal.proposalId, '先发布'),
    { code: 'REVIEW_PENDING' })
  await governance.decideReviewCase(context('reviewer'), { caseId: review.caseId, expectedRevision: 1,
    action: 'keep_both', reason: '金额和否定条件不同，保留独立来源' })
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '已完成差异复核')
})

test('未来定时发布不能提前执行，回退必须生成新审批提案', async (t) => {
  const { governance, prepare } = await fixture(t)
  const a = await prepare('a')
  const first = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'first', entries: [{ ...a, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
    reason: '初版' })
  await governance.approveRelease(context('reviewer'), first.proposalId, '同意')
  const released = await governance.publishApproved(context('owner'), first.proposalId)
  const b = await prepare('b')
  const future = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: released.releaseId, idempotencyKey: 'future',
    entries: [{ ...b, effectiveFrom: '2099-01-01T00:00:00Z', effectiveTo: null }],
    publishNotBefore: '2099-01-01T00:00:00Z', reason: '待生效' })
  await governance.approveRelease(context('reviewer'), future.proposalId, '同意定时发布')
  await assert.rejects(governance.publishApproved(context('owner'), future.proposalId), { code: 'NOT_DUE' })
  const rollback = await governance.proposeRollback(context('owner'), { knowledgeBaseId: 'kb',
    targetReleaseId: released.releaseId, expectedReleaseId: released.releaseId,
    idempotencyKey: 'rollback', reason: '回退方案需重新审核' })
  assert.equal(rollback.preview.added.length, 0)
  assert.equal(rollback.preview.unchanged.length, 1)
  await governance.approveRelease(context('reviewer'), rollback.proposalId, '回退内容已复核')
})

test('标准实体别名保留歧义；模型规则建议只能经原文核验和人工确认', async (t) => {
  const { governance, originals, prepare } = await fixture(t)
  const version = await prepare('a')
  const refA = `knowledge:${version.documentId}:${version.versionId}:${version.buildId}:ruleA`
  const refB = `knowledge:${version.documentId}:${version.versionId}:${version.buildId}:ruleB`
  originals.set(refA, '华东事业部住宿报销上限500元。')
  originals.set(refB, '华东事业部住宿报销上限800元。')
  const first = await governance.createEntity(context('reviewer'), { knowledgeBaseId: 'kb',
    canonicalName: '华东销售中心', entityType: 'department' })
  const second = await governance.createEntity(context('reviewer'), { knowledgeBaseId: 'kb',
    canonicalName: '华东法务中心', entityType: 'department' })
  await governance.addEntityAlias(context('reviewer'), { knowledgeBaseId: 'kb', entityId: first.entityId,
    alias: '华东事业部', sourceRef: refA })
  await governance.addEntityAlias(context('reviewer'), { knowledgeBaseId: 'kb', entityId: second.entityId,
    alias: '华东事业部', sourceRef: refB })
  assert.equal((await governance.resolveEntity(context('reviewer'), 'kb', '华东事业部')).length, 2)
  const base = { sourceRef: refA, subjectId: 'hotel', action: '住宿报销', modality: 'allow' as const,
    condition: '国内出差', threshold: '500', unit: '元', departmentIds: ['east'], regionIds: [],
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, originalText: originals.get(refA)! }
  await assert.rejects(governance.submitRuleSuggestion(context('owner'), { knowledgeBaseId: 'kb',
    rule: { ...base, threshold: '900' } }), { code: 'RULE_THRESHOLD_NOT_IN_SOURCE' })
  const a = await governance.submitRuleSuggestion(context('owner'), { knowledgeBaseId: 'kb', rule: base })
  await governance.confirmRuleSuggestion(context('reviewer'), a.ruleId)
  const b = await governance.submitRuleSuggestion(context('owner'), { knowledgeBaseId: 'kb',
    rule: { ...base, sourceRef: refB, threshold: '800', originalText: originals.get(refB)! } })
  const confirmed = await governance.confirmRuleSuggestion(context('reviewer'), b.ruleId)
  assert.equal(confirmed.conflictCaseIds.length, 1)
})

test('派生知识任一来源失效即拒读并可隔离；历史读取仍需当前 ACL 和历史权限', async (t) => {
  const { foundation, governance, prepare } = await fixture(t)
  const a = await prepare('a')
  await foundation.addAclRule(context('owner'), { knowledgeBaseId: 'kb', resourceType: 'knowledge_base',
    resourceId: 'kb', principalType: 'user', principalId: 'owner', effect: 'allow' })
  await foundation.addAclRule(context('owner'), { knowledgeBaseId: 'kb', resourceType: 'knowledge_base',
    resourceId: 'kb', principalType: 'user', principalId: 'alice', effect: 'allow' })
  const first = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb', expectedReleaseId: null,
    idempotencyKey: 'derive-first', entries: [{ ...a, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
    reason: '初版' })
  await governance.approveRelease(context('reviewer'), first.proposalId, '同意')
  const releaseA = await governance.publishApproved(context('owner'), first.proposalId)
  const ref = `knowledge:${a.documentId}:${a.versionId}:${a.buildId}:chunkA`
  const derived = await governance.registerDerived(context('owner'), { knowledgeBaseId: 'kb', kind: 'faq',
    objectRef: 'private://faq-a', sources: [ref] })
  assert.equal((await governance.authorizeDerivedRead(context('alice'), derived.assetId)).objectRef, 'private://faq-a')
  const b = await prepare('b')
  const second = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: releaseA.releaseId, idempotencyKey: 'derive-second',
    entries: [{ ...b, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }], reason: '新版' })
  assert.deepEqual(second.preview.affectedDerivedIds, [derived.assetId])
  await governance.approveRelease(context('reviewer'), second.proposalId, '新版已核对')
  await governance.publishApproved(context('owner'), second.proposalId)
  await assert.rejects(governance.authorizeDerivedRead(context('alice'), derived.assetId), { code: 'ACCESS_DENIED' })
  assert.equal(await governance.reconcileDerived(context('owner'), derived.assetId), 'quarantined')
  await assert.rejects(foundation.authorizeRead(context('alice'), { knowledgeBaseId: 'kb',
    documentId: a.documentId, versionId: a.versionId, buildId: a.buildId, surface: 'citation' }),
  { code: 'ACCESS_DENIED' })
  assert.equal((await foundation.authorizeArchivedRead(context('alice'), { knowledgeBaseId: 'kb',
    releaseId: releaseA.releaseId, documentId: a.documentId, versionId: a.versionId,
    buildId: a.buildId, asOf: '2026-09-01T00:00:00Z', surface: 'citation' })).releaseId, releaseA.releaseId)
  await assert.rejects(foundation.authorizeArchivedRead(context('reviewer'), { knowledgeBaseId: 'kb',
    releaseId: releaseA.releaseId, documentId: a.documentId, versionId: a.versionId,
    buildId: a.buildId, asOf: '2026-09-01T00:00:00Z', surface: 'citation' }), { code: 'ACCESS_DENIED' })
  await foundation.revokeVersion(context('owner'), { versionId: a.versionId, reason: '撤销历史原件' })
  await assert.rejects(foundation.authorizeArchivedRead(context('alice'), { knowledgeBaseId: 'kb',
    releaseId: releaseA.releaseId, documentId: a.documentId, versionId: a.versionId,
    buildId: a.buildId, asOf: '2026-09-01T00:00:00Z', surface: 'citation' }), { code: 'ACCESS_DENIED' })
})

test('批准后新增冲突仍阻止发布，未定义胜出范围的裁决不能解除冲突', async (t) => {
  const { foundation, governance, originals, prepare } = await fixture(t)
  const a = await prepare('a')
  const proposal = await governance.proposeRelease(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'late-conflict',
    entries: [{ ...a, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
    reason: '先提交' })
  await governance.approveRelease(context('reviewer'), proposal.proposalId, '原文已核对')
  const leftRef = `knowledge:${a.documentId}:${a.versionId}:${a.buildId}:cl`
  const rightRef = `knowledge:${a.documentId}:${a.versionId}:${a.buildId}:cr`
  originals.set(leftRef, '华东制度上限500元。')
  originals.set(rightRef, '华东制度上限800元。')
  const conflict = await governance.createReviewCase(context('owner'), { knowledgeBaseId: 'kb',
    kind: 'conflict', leftRef, rightRef, reason: '审批后发现冲突' })
  await assert.rejects(governance.decideReviewCase(context('reviewer'), { caseId: conflict.caseId,
    expectedRevision: 1, action: 'confirm_supersession', reason: '新制度优先' }),
  { code: 'DECISION_EVIDENCE_REQUIRED' })
  await assert.rejects(governance.decideReviewCase(context('reviewer'), { caseId: conflict.caseId,
    expectedRevision: 1, action: 'mark_exception', reason: '部门例外' }),
  { code: 'DECISION_EVIDENCE_REQUIRED' })
  await assert.rejects(foundation.publish(context('owner'), { knowledgeBaseId: 'kb',
    expectedReleaseId: null, idempotencyKey: 'late-conflict',
    entries: [{ ...a, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }] }),
  /governance approval required/i)
})

test('P4 回退迁移删除治理闸门并保留 P1/P2 基础表', async (t) => {
  const { db } = await fixture(t)
  await db.exec(await readFile(resolve('plugins/knowledge/migrations/0003_p4_governance.down.sql'), 'utf8'))
  const p1 = await db.query<{ name: string }>(`SELECT to_regclass('hz_releases')::text AS name`)
  const p4 = await db.query<{ name: string | null }>(`SELECT to_regclass('hz_p4_review_cases')::text AS name`)
  assert.equal(p1.rows[0].name, 'hz_releases')
  assert.equal(p4.rows[0].name, null)
})
