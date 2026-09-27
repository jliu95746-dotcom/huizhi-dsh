import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresKnowledgeDatabase } from '../src/knowledge/postgres.js'

test('发布事务的所有 SQL 使用同一个连接并在成功后提交', async () => {
  const calls: string[] = []
  const database = new PostgresKnowledgeDatabase({
    query: async () => { throw new Error('事务不得使用 pool.query') },
    connect: async () => ({
      query: async (sql: string) => { calls.push(sql); return { rows: [{ value: 1 }] } },
      release: () => { calls.push('RELEASE') },
    }),
  })
  const result = await database.transaction(async (tx) => {
    const first = await tx.query<{ value: number }>('SELECT 1')
    return first.rows[0].value
  })
  assert.equal(result, 1)
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE'])
})

test('事务失败后回滚并释放连接，不把半成品留在事务里', async () => {
  const calls: string[] = []
  const database = new PostgresKnowledgeDatabase({
    query: async () => { throw new Error('事务不得使用 pool.query') },
    connect: async () => ({
      query: async (sql: string) => { calls.push(sql); return { rows: [] } },
      release: () => { calls.push('RELEASE') },
    }),
  })
  await assert.rejects(database.transaction(async (tx) => {
    await tx.query('INSERT INTO hz_releases VALUES (...)')
    throw new Error('模拟发布失败')
  }), /模拟发布失败/)
  assert.deepEqual(calls, ['BEGIN', 'INSERT INTO hz_releases VALUES (...)', 'ROLLBACK', 'RELEASE'])
})
