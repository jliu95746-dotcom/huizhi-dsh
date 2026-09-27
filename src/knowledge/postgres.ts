import type { Pool } from 'pg'
import type { SqlDatabase, SqlSession } from './foundation.js'

interface ClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(destroy?: boolean): void
}

interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  connect(): Promise<ClientLike>
}

export class PostgresKnowledgeDatabase implements SqlDatabase {
  constructor(private readonly pool: PoolLike) {}

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const result = await this.pool.query(sql, params)
    return { rows: result.rows as T[] }
  }

  async transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let destroy = false
    try {
      await client.query('BEGIN')
      const session: SqlSession = {
        query: async <Row extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params)
          return { rows: result.rows as Row[] }
        },
      }
      const result = await work(session)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        destroy = true
        throw new AggregateError([error, rollbackError], '知识库事务失败且回滚失败')
      }
      throw error
    } finally {
      client.release(destroy)
    }
  }
}

export function postgresKnowledgeDatabase(pool: Pool): PostgresKnowledgeDatabase {
  return new PostgresKnowledgeDatabase({
    query: async (sql, params) => {
      const result = await pool.query(sql, params)
      return { rows: result.rows }
    },
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async (sql, params) => {
          const result = await client.query(sql, params)
          return { rows: result.rows }
        },
        release: (destroy) => client.release(destroy),
      }
    },
  })
}
