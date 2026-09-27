import { createHash } from 'node:crypto'
import { KnowledgeError } from './foundation.js'
import type { KnowledgeChunk } from './chunking.js'

export interface EmbeddingProvider {
  embed(input: { modelIdentity: string; items: Array<{ id: string; text: string }> }): Promise<{
    modelIdentity: string; vectors: Array<{ id: string; values: number[] }>
  }>
}
export interface EmbeddingCache {
  get(key: string): Promise<number[] | null>
  put(key: string, values: number[]): Promise<void>
}
export class EmbeddingProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(message) }
}
export interface EmbeddedChunk {
  chunk: KnowledgeChunk
  vector: number[]
  contentHash: string
}

const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')
const validVector = (values: unknown, dimension: number): values is number[] =>
  Array.isArray(values) && values.length === dimension && values.every((value) => typeof value === 'number' && Number.isFinite(value))

export async function embedChunks(input: {
  tenantId: number; chunks: KnowledgeChunk[]; modelIdentity: string; dimensions: number
  maxBatchItems: number; maxBatchTokens: number; maxAttempts: number
  provider: EmbeddingProvider; cache: EmbeddingCache; delay?: (ms: number) => Promise<void>
}): Promise<EmbeddedChunk[]> {
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId < 1 || !input.modelIdentity ||
      !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 ||
      !Number.isSafeInteger(input.maxBatchItems) || input.maxBatchItems < 1 ||
      !Number.isSafeInteger(input.maxBatchTokens) || input.maxBatchTokens < 1 ||
      !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5 ||
      new Set(input.chunks.map((chunk) => chunk.id)).size !== input.chunks.length) {
    throw new KnowledgeError('INVALID_INPUT', 'Embedding 配置或片段清单无效')
  }
  const output = new Map<string, EmbeddedChunk>()
  const pending: KnowledgeChunk[] = []
  const keyOf = (chunk: KnowledgeChunk) => `${input.tenantId}:${input.modelIdentity}:${contentHash(chunk.text)}`
  for (const chunk of input.chunks) {
    if (chunk.tokenCount > input.maxBatchTokens) throw new KnowledgeError('EMBEDDING_TOO_LONG', '片段超过模型批次 token 限制')
    const cached = await input.cache.get(keyOf(chunk))
    if (cached !== null && validVector(cached, input.dimensions)) {
      output.set(chunk.id, { chunk, vector: cached, contentHash: contentHash(chunk.text) })
    } else {
      pending.push(chunk)
    }
  }
  const batches: KnowledgeChunk[][] = []
  let batch: KnowledgeChunk[] = []
  let tokens = 0
  for (const chunk of pending) {
    if (batch.length && (batch.length >= input.maxBatchItems || tokens + chunk.tokenCount > input.maxBatchTokens)) {
      batches.push(batch); batch = []; tokens = 0
    }
    batch.push(chunk); tokens += chunk.tokenCount
  }
  if (batch.length) batches.push(batch)
  for (const items of batches) {
    let result: Awaited<ReturnType<EmbeddingProvider['embed']>> | undefined
    for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
      try {
        result = await input.provider.embed({ modelIdentity: input.modelIdentity,
          items: items.map((chunk) => ({ id: chunk.id, text: chunk.text })) })
        break
      } catch (error) {
        if (!(error instanceof EmbeddingProviderError) || !error.retryable || attempt === input.maxAttempts) throw error
        if (error.retryAfterMs > 30_000) throw error
        const waitMs = Math.max(error.retryAfterMs, 100 * 2 ** (attempt - 1))
        await (input.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(waitMs)
      }
    }
    if (!result || result.modelIdentity !== input.modelIdentity || result.vectors.length !== items.length ||
        new Set(result.vectors.map((vector) => vector.id)).size !== items.length) {
      throw new KnowledgeError('EMBEDDING_RESPONSE_INVALID', 'Embedding 响应模型或条数不匹配')
    }
    const byId = new Map(result.vectors.map((vector) => [vector.id, vector.values]))
    const validated = items.map((chunk) => {
      const values = byId.get(chunk.id)
      if (!validVector(values, input.dimensions)) {
        throw new KnowledgeError('EMBEDDING_RESPONSE_INVALID', 'Embedding 向量维度、数值或 ID 无效')
      }
      return { chunk, values }
    })
    for (const { chunk, values } of validated) {
      output.set(chunk.id, { chunk, vector: values, contentHash: contentHash(chunk.text) })
      await input.cache.put(keyOf(chunk), values)
    }
  }
  return input.chunks.map((chunk) => output.get(chunk.id)!)
}
