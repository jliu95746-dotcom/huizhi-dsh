import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'

const owner: VerifiedKnowledgeActor = {
  tenantId: 7, organizationId: 'org-a', requesterId: 'owner',
  principals: [{ type: 'user', id: 'owner' }],
  permissions: ['ingest', 'publish', 'manage_acl', 'revoke', 'read_history', 'outbox'],
}
const employee: VerifiedKnowledgeActor = {
  tenantId: 7, organizationId: 'org-a', requesterId: 'alice',
  principals: [{ type: 'user', id: 'alice' }, { type: 'department', id: 'legal' }], permissions: [],
}
const outsider: VerifiedKnowledgeActor = {
  tenantId: 7, organizationId: 'org-a', requesterId: 'bob',
  principals: [{ type: 'user', id: 'bob' }, { type: 'department', id: 'hr' }], permissions: [],
}
const otherTenant: VerifiedKnowledgeActor = {
  tenantId: 8, organizationId: 'org-b', requesterId: 'eve',
  principals: [{ type: 'user', id: 'eve' }], permissions: [],
}
const actors: Record<string, VerifiedKnowledgeActor> = { owner, employee, outsider, otherTenant }
const context = (credential: string, requesterId = actors[credential].requesterId) => ({
  serviceCredential: credential, organizationId: actors[credential].organizationId, requesterId,
})

async function fixture(t: TestContext) {
  const database = await PGlite.create()
  const indexState = { verified: true }
  t.after(async () => database.close())
  const migration = await readFile(resolve('plugins/knowledge/migrations/0001_p1_foundation.up.sql'), 'utf8')
  await database.exec(migration)
  const foundation = new KnowledgeFoundation({
    query: (sql, params) => database.query(sql, params),
    transaction: (work) => database.transaction(async (tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  }, {
    verify: async (request) => {
      const actor = actors[request.serviceCredential]
      if (!actor) throw new Error('服务身份无效')
      return actor
    },
  }, { verify: async () => indexState.verified }, () => new Date('2026-09-27T12:00:00Z'))
  return { database, foundation, indexState }
}

async function preparedVersion(foundation: KnowledgeFoundation, revision = 'r1', source = 'policy-1') {
  const version = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: source,
    sourceRevision: revision, contentHash: revision === 'r1' ? 'a'.repeat(64) : 'b'.repeat(64),
    objectRef: `private://synthetic/${source}/${revision}`,
  })
  const run = await foundation.startBuild(context('owner'), {
    versionId: version.versionId, pipelineFingerprint: `pipeline-${revision}`,
    idempotencyKey: `build-${source}-${revision}`,
  })
  await foundation.completeBuild(context('owner'), { runId: run.runId, generation: run.generation })
  return { ...version, buildId: run.buildId }
}

test('文档版本不可变，同一来源修订号不能指向不同原件', async (t) => {
  const { foundation, database } = await fixture(t)
  const first = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'policy-1',
    sourceRevision: 'r1', contentHash: 'a'.repeat(64), objectRef: 'private://synthetic/r1',
  })
  const repeated = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'policy-1',
    sourceRevision: 'r1', contentHash: 'a'.repeat(64), objectRef: 'private://synthetic/r1',
  })
  assert.deepEqual(repeated, first)
  await assert.rejects(foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'policy-1',
    sourceRevision: 'r1', contentHash: 'b'.repeat(64), objectRef: 'private://synthetic/changed',
  }), { code: 'REVISION_CONFLICT' })
  await assert.rejects(database.query(`UPDATE hz_document_versions SET content_hash=$2 WHERE id=$1`,
    [first.versionId, 'c'.repeat(64)]), /immutable/i)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_document_versions')).rows[0].count, 1)
})

test('身份伪造被拒，拒绝规则优先于允许规则，所有读取面共用闸门', async (t) => {
  const { foundation } = await fixture(t)
  const version = await preparedVersion(foundation)
  const release = await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'publish-1',
    entries: [{ ...version, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  })
  await foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'knowledge_base', resourceId: 'kb-1',
    principalType: 'department', principalId: 'legal', effect: 'allow',
  })
  const read = { knowledgeBaseId: 'kb-1', documentId: version.documentId, versionId: version.versionId, buildId: version.buildId }
  for (const surface of ['search', 'original', 'parent', 'citation', 'download'] as const) {
    assert.equal((await foundation.authorizeRead(context('employee'), { ...read, surface })).releaseId, release.releaseId)
    await assert.rejects(foundation.authorizeRead(context('outsider'), { ...read, surface }), { code: 'ACCESS_DENIED' })
  }
  await assert.rejects(foundation.authorizeRead(context('outsider', 'alice'), { ...read, surface: 'search' }), { code: 'IDENTITY_MISMATCH' })
  await assert.rejects(foundation.authorizeRead(context('otherTenant'), { ...read, surface: 'search' }), { code: 'ACCESS_DENIED' })
  await assert.rejects(foundation.authorizeRead(context('employee'), {
    ...read, surface: 'search', asOf: '2026-09-27T12:00:00Z',
  }), { code: 'ACCESS_DENIED' })
  await assert.rejects(foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'knowledge_base', resourceId: 'kb-1',
    principalType: 'everyone', principalId: 'legal', effect: 'allow',
  }), { code: 'INVALID_INPUT' })
  const denied = await foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'document', resourceId: version.documentId,
    principalType: 'user', principalId: 'alice', effect: 'deny',
  })
  await assert.rejects(foundation.authorizeRead(context('employee'), { ...read, surface: 'parent' }), { code: 'ACCESS_DENIED' })
  const revoked = await foundation.revokeAclRule(context('owner'), denied.ruleId)
  assert.ok(revoked.revision > denied.revision)
  await foundation.authorizeRead(context('employee'), { ...read, surface: 'parent' })
})

test('未发布、未来生效、旧快照及紧急撤销不能进入当前读取', async (t) => {
  const { foundation } = await fixture(t)
  const oldVersion = await preparedVersion(foundation, 'r1')
  const read = (version: typeof oldVersion) => ({ knowledgeBaseId: 'kb-1', documentId: version.documentId, versionId: version.versionId, buildId: version.buildId, surface: 'search' as const })
  await foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'knowledge_base', resourceId: 'kb-1',
    principalType: 'user', principalId: 'alice', effect: 'allow',
  })
  await assert.rejects(foundation.authorizeRead(context('employee'), read(oldVersion)), { code: 'ACCESS_DENIED' })
  const first = await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'release-1',
    entries: [{ ...oldVersion, effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null }],
  })
  await assert.rejects(foundation.authorizeRead(context('employee'), read(oldVersion)), { code: 'ACCESS_DENIED' })
  const newVersion = await preparedVersion(foundation, 'r2')
  await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: first.releaseId, idempotencyKey: 'release-2',
    entries: [{ ...newVersion, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  })
  await assert.rejects(foundation.authorizeRead(context('employee'), read(oldVersion)), { code: 'ACCESS_DENIED' })
  await foundation.authorizeRead(context('employee'), read(newVersion))
  await foundation.revokeVersion(context('owner'), { versionId: newVersion.versionId, reason: '紧急撤销' })
  await assert.rejects(foundation.authorizeRead(context('employee'), read(newVersion)), { code: 'ACCESS_DENIED' })
})

test('同一文档的历史与当前版本可按不重叠有效区间发布', async (t) => {
  const { foundation } = await fixture(t)
  const oldVersion = await preparedVersion(foundation, 'r1')
  const first = await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'history-first',
    entries: [{ ...oldVersion, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  })
  const newVersion = await preparedVersion(foundation, 'r2')
  await foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'knowledge_base', resourceId: 'kb-1',
    principalType: 'everyone', principalId: '*', effect: 'allow',
  })
  await assert.rejects(foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: first.releaseId, idempotencyKey: 'history-overlap',
    entries: [
      { ...oldVersion, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null },
      { ...newVersion, effectiveFrom: '2026-06-01T00:00:00Z', effectiveTo: null },
    ],
  }), { code: 'INVALID_INPUT' })
  await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: first.releaseId, idempotencyKey: 'history-second',
    entries: [
      { ...oldVersion, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-06-01T00:00:00Z' },
      { ...newVersion, effectiveFrom: '2026-06-01T00:00:00Z', effectiveTo: null },
    ],
  })
  const read = (version: typeof oldVersion) => ({ ...version, knowledgeBaseId: 'kb-1', surface: 'search' as const })
  await assert.rejects(foundation.authorizeRead(context('employee'), read(oldVersion)), { code: 'ACCESS_DENIED' })
  await assert.rejects(foundation.authorizeRead(context('employee'), {
    ...read(oldVersion), asOf: '2026-03-01T00:00:00Z',
  }), { code: 'ACCESS_DENIED' })
  await foundation.authorizeRead(context('owner'), { ...read(oldVersion), asOf: '2026-03-01T00:00:00Z' })
  await foundation.authorizeRead(context('employee'), read(newVersion))
})

test('任务幂等，旧代次不能完成并覆盖新构建', async (t) => {
  const { foundation } = await fixture(t)
  const version = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'contract-1',
    sourceRevision: 'r1', contentHash: 'c'.repeat(64), objectRef: 'private://synthetic/contract',
  })
  const input = { versionId: version.versionId, pipelineFingerprint: 'pipeline-1', idempotencyKey: 'run-1' }
  const first = await foundation.startBuild(context('owner'), input)
  const repeated = await foundation.startBuild(context('owner'), input)
  assert.deepEqual({ ...repeated, startedNow: true }, first)
  assert.equal(repeated.startedNow, false)
  const second = await foundation.startBuild(context('owner'), { ...input, idempotencyKey: 'run-2' })
  assert.equal(second.buildId, first.buildId)
  assert.ok(second.generation > first.generation)
  await assert.rejects(foundation.completeBuild(context('owner'), {
    runId: first.runId, generation: first.generation,
  }), { code: 'STALE_RUN' })
  await foundation.completeBuild(context('owner'), { runId: second.runId, generation: second.generation })
  await foundation.completeBuild(context('owner'), { runId: second.runId, generation: second.generation })
})

test('可信索引校验失败时，构建与发布都保持未就绪', async (t) => {
  const { foundation, indexState } = await fixture(t)
  const version = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'unindexed',
    sourceRevision: 'r1', contentHash: 'd'.repeat(64), objectRef: 'private://synthetic/unindexed',
  })
  const run = await foundation.startBuild(context('owner'), {
    versionId: version.versionId, pipelineFingerprint: 'pipeline-1', idempotencyKey: 'unindexed-run',
  })
  indexState.verified = false
  await assert.rejects(foundation.completeBuild(context('owner'), {
    runId: run.runId, generation: run.generation,
  }), { code: 'INDEX_NOT_VERIFIED' })
  await assert.rejects(foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'unindexed-release',
    entries: [{ ...version, buildId: run.buildId, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  }), { code: 'BUILD_NOT_READY' })
})

test('新版本构建失败时旧发布继续有效，未就绪构建不能发布', async (t) => {
  const { foundation } = await fixture(t)
  const oldVersion = await preparedVersion(foundation, 'r1')
  await foundation.addAclRule(context('owner'), {
    knowledgeBaseId: 'kb-1', resourceType: 'knowledge_base', resourceId: 'kb-1',
    principalType: 'user', principalId: 'alice', effect: 'allow',
  })
  const first = await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'old-release',
    entries: [{ ...oldVersion, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  })
  const newVersion = await foundation.registerVersion(context('owner'), {
    knowledgeBaseId: 'kb-1', sourceSystem: 'test', sourceDocumentId: 'policy-1',
    sourceRevision: 'r2', contentHash: 'b'.repeat(64), objectRef: 'private://synthetic/r2',
  })
  const run = await foundation.startBuild(context('owner'), {
    versionId: newVersion.versionId, pipelineFingerprint: 'pipeline-r2', idempotencyKey: 'failed-run',
  })
  await assert.rejects(foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: first.releaseId, idempotencyKey: 'premature-release',
    entries: [{ ...newVersion, buildId: run.buildId, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  }), { code: 'BUILD_NOT_READY' })
  await foundation.failBuild(context('owner'), { runId: run.runId, generation: run.generation, reason: '解析失败' })
  const read = { knowledgeBaseId: 'kb-1', documentId: oldVersion.documentId,
    versionId: oldVersion.versionId, buildId: oldVersion.buildId, surface: 'search' as const }
  assert.equal((await foundation.authorizeRead(context('employee'), read)).releaseId, first.releaseId)
  const retry = await foundation.startBuild(context('owner'), {
    versionId: newVersion.versionId, pipelineFingerprint: 'pipeline-r2', idempotencyKey: 'retry-run',
  })
  assert.ok(retry.generation > run.generation)
  await assert.rejects(foundation.completeBuild(context('owner'), {
    runId: run.runId, generation: run.generation,
  }), { code: 'STALE_RUN' })
})

test('发布使用 expectedReleaseId 比较并交换，重复提交不重复发布或投递事件', async (t) => {
  const { foundation, database } = await fixture(t)
  const version = await preparedVersion(foundation)
  const base = {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null,
    entries: [{ ...version, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  }
  const outcomes = await Promise.allSettled([
    foundation.publish(context('owner'), { ...base, idempotencyKey: 'publish-a' }),
    foundation.publish(context('owner'), { ...base, idempotencyKey: 'publish-b' }),
  ])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((result) => result.status === 'rejected' && result.reason?.code === 'RELEASE_CONFLICT').length, 1)
  const first = outcomes.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof foundation.publish>>> => result.status === 'fulfilled')!.value
  const idempotencyKey = first.idempotencyKey
  assert.deepEqual(await foundation.publish(context('owner'), { ...base, idempotencyKey }), first)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_releases')).rows[0].count, 1)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_outbox')).rows[0].count, 1)
  assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM hz_audit_events WHERE action = $1', ['release.published'])).rows[0].count, 1)
})

test('Outbox 租约可重试，旧租约不能确认新投递', async (t) => {
  const { foundation, database } = await fixture(t)
  const version = await preparedVersion(foundation)
  await foundation.publish(context('owner'), {
    knowledgeBaseId: 'kb-1', expectedReleaseId: null, idempotencyKey: 'publish-outbox',
    entries: [{ ...version, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }],
  })
  const first = await foundation.leaseOutbox(context('owner'), { limit: 10, leaseSeconds: 60 })
  assert.equal(first.length, 1)
  assert.deepEqual(await foundation.leaseOutbox(context('owner'), { limit: 10, leaseSeconds: 60 }), [])
  await foundation.failOutbox(context('owner'), { eventId: first[0].eventId, leaseToken: first[0].leaseToken, retryAfterSeconds: 0 })
  const second = await foundation.leaseOutbox(context('owner'), { limit: 10, leaseSeconds: 60 })
  assert.equal(second.length, 1)
  assert.notEqual(second[0].leaseToken, first[0].leaseToken)
  await assert.rejects(foundation.ackOutbox(context('owner'), {
    eventId: first[0].eventId, leaseToken: first[0].leaseToken,
  }), { code: 'STALE_EVENT_LEASE' })
  await foundation.ackOutbox(context('owner'), { eventId: second[0].eventId, leaseToken: second[0].leaseToken })
  assert.deepEqual(await foundation.leaseOutbox(context('owner'), { limit: 10, leaseSeconds: 60 }), [])
  assert.equal((await database.query<{ attempts: number; delivered_at: string | null }>(
    'SELECT attempts, delivered_at FROM hz_outbox WHERE id=$1', [first[0].eventId],
  )).rows[0].attempts, 2)
})

test('迁移可完整回退，不触碰上游表', async (t) => {
  const { database } = await fixture(t)
  await database.exec(await readFile(resolve('plugins/knowledge/migrations/0001_p1_foundation.down.sql'), 'utf8'))
  const rows = (await database.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname='public' AND tablename LIKE 'hz_%'`)).rows
  assert.deepEqual(rows, [])
})
