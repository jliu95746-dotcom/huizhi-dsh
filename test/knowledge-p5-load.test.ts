import assert from 'node:assert/strict'
import test from 'node:test'
import { runKnowledgeLoad } from '../src/knowledge/load-test.js'

test('负载工具分开统计 10 并发冷启动、稳定请求和混合入库', async () => {
  let active = 0
  let peak = 0
  let ingestions = 0
  const report = await runKnowledgeLoad({ concurrency: 10, requestsPerWorker: 2,
    runQuery: async ({ phase, sequence }) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return { ok: phase === 'cold' || sequence !== 1, costMicros: 5 }
    },
    runIngestion: async () => { ingestions++ },
  })
  assert.equal(report.cold.requests, 10)
  assert.equal(report.steady.requests, 20)
  assert.equal(report.steady.failures, 10)
  assert.equal(report.steady.costMicros, 100)
  assert.equal(report.ingestion.completed, true)
  assert.equal(ingestions, 1)
  assert.equal(peak, 10)
  assert.ok(report.cold.p95Ms >= 0)
})
