import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { KnowledgeFoundation, type SqlDatabase, type VerifiedKnowledgeActor } from '../src/knowledge/foundation.js'
import { KnowledgeOutboxWorker } from '../src/knowledge/outbox-worker.js'

async function fixture(t: TestContext) {
  const db = await PGlite.create()
  t.after(async () => db.close())
  await db.exec(await readFile(resolve('plugins/knowledge/migrations/0001_p1_foundation.up.sql'), 'utf8'))
  const sql: SqlDatabase = {
    query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
      ({ rows: (await db.query<Row>(query, params)).rows }),
    transaction: (work) => db.transaction(async (tx) => work({
      query: async <Row extends Record<string, unknown>>(query: string, params?: unknown[]) =>
        ({ rows: (await tx.query<Row>(query, params)).rows }),
    })),
  }
  const actor: VerifiedKnowledgeActor = { tenantId: 7, organizationId: 'org', requesterId: 'worker',
    principals: [{ type: 'user', id: 'worker' }], permissions: ['outbox'] }
  const identity = { verify: async () => actor }
  let now = new Date('2026-09-27T12:00:00Z')
  const clock = () => now
  const foundation = new KnowledgeFoundation(sql, identity, { verify: async () => true }, clock)
  const context = { serviceCredential: 'worker', organizationId: 'org', requesterId: 'worker' }
  await db.query(`INSERT INTO hz_outbox
    (id, tenant_id, topic, aggregate_id, payload, available_at)
    VALUES ('event-1',7,'release.published','release-1','{}'::jsonb,'2026-09-27T11:00:00Z')`)
  return { db, foundation, context, advance: (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000)
  } }
}

test('429 重投后成功确认；中断后的旧租约到期可恢复且不会假成功', async (t) => {
  const { db, foundation, context, advance } = await fixture(t)
  const failing = new KnowledgeOutboxWorker(foundation, async () => {
    throw { status: 429 }
  })
  const first = await failing.runOnce(context, 1)
  assert.equal(first.retrying, 1)
  assert.equal((await db.query<{ delivered_at: string | null }>(
    `SELECT delivered_at FROM hz_outbox WHERE id='event-1'`)).rows[0].delivered_at, null)
  advance(10)
  const stranded = await foundation.leaseOutbox(context, { limit: 1, leaseSeconds: 5 })
  assert.equal(stranded.length, 1)
  advance(10)
  let handled = 0
  const recovered = new KnowledgeOutboxWorker(foundation, async () => { handled++ })
  const final = await recovered.runOnce(context, 1)
  assert.equal(final.delivered, 1)
  assert.equal(handled, 1)
  await assert.rejects(foundation.ackOutbox(context, { eventId: 'event-1',
    leaseToken: stranded[0].leaseToken }), { code: 'STALE_EVENT_LEASE' })
})

test('401 进入人工处置延迟，不确认事件已投递', async (t) => {
  const { db, foundation, context } = await fixture(t)
  const worker = new KnowledgeOutboxWorker(foundation, async () => { throw { status: 401 } })
  const result = await worker.runOnce(context, 1)
  assert.equal(result.manualReview, 1)
  assert.equal((await db.query<{ delivered_at: string | null }>(
    `SELECT delivered_at FROM hz_outbox WHERE id='event-1'`)).rows[0].delivered_at, null)
})
