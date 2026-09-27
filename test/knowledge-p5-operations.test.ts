import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeOperations, classifyProviderFailure } from '../src/knowledge/operations.js'
import { KnowledgeQueryService } from '../src/knowledge/query.js'

const actors: Record<string, VerifiedKnowledgeActor> = {
  worker: { tenantId: 7, organizationId: 'org', requesterId: 'worker',
    principals: [{ type: 'user', id: 'worker' }], permissions: ['outbox'] },
  auditor: { tenantId: 7, organizationId: 'org', requesterId: 'auditor',
    principals: [{ type: 'user', id: 'auditor' }], permissions: ['audit_read'] },
  alice: { tenantId: 7, organizationId: 'org', requesterId: 'alice',
    principals: [{ type: 'user', id: 'alice' }], permissions: [] },
}
const identity = { verify: async (input: { serviceCredential: string }) => actors[input.serviceCredential] }
const context = (who: keyof typeof actors) => ({ serviceCredential: who,
  organizationId: 'org', requesterId: who })
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
  return { db, operations: new KnowledgeOperations(sql, identity) }
}

test('指标只保存有限字段，审计和运行快照按权限查询', async (t) => {
  const { db, operations } = await fixture(t)
  await operations.record(context('worker'), { knowledgeBaseId: 'kb', traceId: 'trace-1',
    stage: 'rerank', outcome: 'rate_limited', durationMs: 1200, tokenCount: 0,
    costMicros: 0, httpStatus: 429 })
  await operations.record(context('worker'), { knowledgeBaseId: 'kb', traceId: 'trace-2',
    stage: 'retrieval', outcome: 'ok', durationMs: 200, tokenCount: 30,
    costMicros: 2000, httpStatus: null })
  await assert.rejects(operations.snapshot(context('alice'), 'kb', 60), { code: 'ACCESS_DENIED' })
  const snapshot = await operations.snapshot(context('auditor'), 'kb', 60)
  assert.equal(snapshot.requests, 2)
  assert.equal(snapshot.rateLimited, 1)
  assert.equal(snapshot.costMicros, 2000)
  assert.equal(snapshot.p95DurationMs, 1200)
  assert.ok(operations.alerts(snapshot, { maxErrorRate: 0.4, maxP95Ms: 1000,
    maxCostMicros: 1000 }).length >= 2)
  await db.query(`INSERT INTO hz_audit_events
    (id, tenant_id, actor_id, action, resource_type, resource_id, result)
    VALUES ('audit-1',7,'worker','test.action','document','doc-1','success')`)
  assert.equal((await operations.readAudit(context('auditor'), 'document', 'doc-1', 20)).length, 1)
  await assert.rejects(operations.readAudit(context('alice'), 'document', 'doc-1', 20),
    { code: 'ACCESS_DENIED' })
})

test('429/5xx/超时分类为可重试，认证和配置错误不伪装成功', () => {
  assert.deepEqual(classifyProviderFailure({ status: 429 }), { kind: 'rate_limited', retryable: true })
  assert.deepEqual(classifyProviderFailure({ status: 503 }), { kind: 'temporary', retryable: true })
  assert.deepEqual(classifyProviderFailure({ code: 'ETIMEDOUT' }), { kind: 'timeout', retryable: true })
  assert.deepEqual(classifyProviderFailure({ status: 401 }), { kind: 'authentication', retryable: false })
  assert.deepEqual(classifyProviderFailure({ status: 400 }), { kind: 'invalid_request', retryable: false })
})

test('索引故障时问答返回 degraded 而非成功或空资料', async () => {
  const query = new KnowledgeQueryService(identity,
    { authorizeRead: async () => ({ releaseId: 'release', epoch: 1, aclRevision: 1 }) },
    { keyword: async () => { throw new Error('index unavailable') },
      vector: async () => [], exactNumber: async () => [] },
    { rerank: async () => [] })
  const result = await query.search(context('alice'), '住宿上限是多少？')
  assert.equal(result.status, 'degraded')
  assert.equal(result.hits.length, 0)
})
