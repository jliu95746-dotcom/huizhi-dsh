import { KnowledgeError } from './foundation.js'

export interface LoadSample { ok: boolean; costMicros: number }
export interface LoadSummary { requests: number; failures: number; errorRate: number;
  p50Ms: number; p95Ms: number; maxMs: number; costMicros: number }
export interface KnowledgeLoadReport { concurrency: number; cold: LoadSummary; steady: LoadSummary;
  ingestion: { attempted: boolean; completed: boolean } }

const summarize = (samples: Array<{ durationMs: number; ok: boolean; costMicros: number }>): LoadSummary => {
  const times = samples.map((item) => item.durationMs).sort((a, b) => a - b)
  const failures = samples.filter((item) => !item.ok).length
  const percentile = (fraction: number) => times.length ? times[Math.ceil(times.length * fraction) - 1] : 0
  return { requests: samples.length, failures, errorRate: samples.length ? failures / samples.length : 0,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: times.at(-1) ?? 0,
    costMicros: samples.reduce((sum, item) => sum + item.costMicros, 0) }
}

export async function runKnowledgeLoad(input: {
  concurrency: number
  requestsPerWorker: number
  runQuery: (task: { phase: 'cold' | 'steady'; worker: number; sequence: number }) => Promise<LoadSample>
  runIngestion?: () => Promise<void>
}): Promise<KnowledgeLoadReport> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 100 ||
    !Number.isSafeInteger(input.requestsPerWorker) || input.requestsPerWorker < 1 ||
    input.requestsPerWorker > 1000 || typeof input.runQuery !== 'function') {
    throw new KnowledgeError('INVALID_INPUT', '负载测试参数无效')
  }
  const invoke = async (phase: 'cold' | 'steady', worker: number, sequence: number) => {
    const start = performance.now()
    let ok = false
    let costMicros = 0
    try {
      const result = await input.runQuery({ phase, worker, sequence })
      ok = result?.ok === true && Number.isSafeInteger(result.costMicros) && result.costMicros >= 0
      if (Number.isSafeInteger(result?.costMicros) && result.costMicros >= 0) costMicros = result.costMicros
    } catch { /* 失败计入错误率，不记录可能含敏感内容的原始异常。 */ }
    return { durationMs: performance.now() - start, ok, costMicros }
  }
  const cold = await Promise.all(Array.from({ length: input.concurrency }, (_, worker) =>
    invoke('cold', worker, 0)))
  let ingestionCompleted = false
  const ingestion = input.runIngestion ? input.runIngestion().then(() => {
    ingestionCompleted = true
  }).catch(() => { ingestionCompleted = false }) : Promise.resolve()
  const steady = (await Promise.all(Array.from({ length: input.concurrency }, async (_, worker) => {
    const samples = []
    for (let sequence = 0; sequence < input.requestsPerWorker; sequence++) {
      samples.push(await invoke('steady', worker, sequence))
    }
    return samples
  }))).flat()
  await ingestion
  return { concurrency: input.concurrency, cold: summarize(cold), steady: summarize(steady),
    ingestion: { attempted: !!input.runIngestion, completed: ingestionCompleted } }
}
