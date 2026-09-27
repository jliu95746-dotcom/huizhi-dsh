import { createHash } from 'node:crypto'
import { KnowledgeError } from './foundation.js'
import type { ParsedBlock, SourceLocation } from './processing.js'

export interface TokenCounter { count(text: string): number }
export interface SemanticBoundaryModel {
  propose(input: { blocks: Array<{ id: string; type: ParsedBlock['type']; text: string }> }):
    Promise<{ beforeBlockIds: string[]; modelIdentity: string }>
}
export interface KnowledgeChunk {
  id: string
  parentId: string
  text: string
  blockIds: string[]
  locations: SourceLocation[]
  tokenCount: number
}
export interface ParentChunk {
  id: string
  childIds: string[]
  text: string
  tokenCount: number
}
export interface ChunkingResult {
  chunks: KnowledgeChunk[]
  parents: ParentChunk[]
  modelIdentity: string | null
  fallbackReason: string | null
  warnings: string[]
}

const stableId = (buildId: string, kind: string, ids: string[]) =>
  createHash('sha256').update(JSON.stringify([buildId, kind, ids])).digest('hex')

export async function splitIntoChunks(input: {
  buildId: string; blocks: ParsedBlock[]; maxChildTokens: number; maxParentTokens: number;
  minChildTokens: number; tokenCounter: TokenCounter; boundaryModel: SemanticBoundaryModel
}): Promise<ChunkingResult> {
  if (!input.buildId || !input.blocks.length || !Number.isSafeInteger(input.maxChildTokens) ||
      !Number.isSafeInteger(input.maxParentTokens) || !Number.isSafeInteger(input.minChildTokens) ||
      input.maxChildTokens < 1 || input.maxParentTokens < input.maxChildTokens ||
      input.minChildTokens < 1 || input.minChildTokens > input.maxChildTokens ||
      new Set(input.blocks.map((block) => block.id)).size !== input.blocks.length) {
    throw new KnowledgeError('INVALID_INPUT', '切分配置或块清单无效')
  }
  const tokenCounts = input.blocks.map((block) => input.tokenCounter.count(block.text))
  if (tokenCounts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > input.maxChildTokens)) {
    throw new KnowledgeError('CHUNK_TOO_LARGE', '单个结构块超过片段上限，必须人工处理或调整结构')
  }
  let boundaries = new Set<string>()
  let modelIdentity: string | null = null
  let fallbackReason: string | null = null
  try {
    const result = await input.boundaryModel.propose({ blocks: input.blocks.map((block) =>
      ({ id: block.id, type: block.type, text: block.text })) })
    const valid = new Set(input.blocks.slice(1).map((block) => block.id))
    if (!result.modelIdentity || !Array.isArray(result.beforeBlockIds) ||
        result.beforeBlockIds.some((id) => !valid.has(id)) ||
        new Set(result.beforeBlockIds).size !== result.beforeBlockIds.length) {
      fallbackReason = 'SEMANTIC_BOUNDARY_INVALID'
    } else {
      boundaries = new Set(result.beforeBlockIds)
      modelIdentity = result.modelIdentity
    }
  } catch {
    fallbackReason = 'SEMANTIC_MODEL_UNAVAILABLE'
  }
  const chunks: KnowledgeChunk[] = []
  let current: ParsedBlock[] = []
  let currentTokens = 0
  const flush = () => {
    if (!current.length) return
    const ids = current.map((block) => block.id)
    chunks.push({ id: stableId(input.buildId, 'child', ids), parentId: '',
      text: current.map((block) => block.text).join('\n'), blockIds: ids,
      locations: current.map((block) => block.location), tokenCount: currentTokens })
    current = []; currentTokens = 0
  }
  input.blocks.forEach((block) => {
    const combined = input.tokenCounter.count([...current.map((item) => item.text), block.text].join('\n'))
    if (current.length && (boundaries.has(block.id) || block.type === 'heading' ||
        combined > input.maxChildTokens)) flush()
    current.push(block)
    currentTokens = input.tokenCounter.count(current.map((item) => item.text).join('\n'))
  })
  flush()
  const parents: ParentChunk[] = []
  let group: KnowledgeChunk[] = []
  let groupTokens = 0
  const flushParent = () => {
    if (!group.length) return
    const id = stableId(input.buildId, 'parent', group.map((chunk) => chunk.id))
    group.forEach((chunk) => { chunk.parentId = id })
    parents.push({ id, childIds: group.map((chunk) => chunk.id), text: group.map((chunk) => chunk.text).join('\n'),
      tokenCount: groupTokens })
    group = []; groupTokens = 0
  }
  for (const chunk of chunks) {
    const combined = input.tokenCounter.count([...group.map((item) => item.text), chunk.text].join('\n'))
    if (group.length && combined > input.maxParentTokens) flushParent()
    group.push(chunk)
    groupTokens = input.tokenCounter.count(group.map((item) => item.text).join('\n'))
  }
  flushParent()
  const covered = chunks.flatMap((chunk) => chunk.blockIds)
  if (covered.length !== input.blocks.length || covered.some((id, index) => id !== input.blocks[index].id)) {
    throw new KnowledgeError('CHUNK_COVERAGE', '切分结果没有完整覆盖原文块')
  }
  return { chunks, parents, modelIdentity, fallbackReason,
    warnings: chunks.filter((chunk) => chunk.tokenCount < input.minChildTokens).map((chunk) => `SHORT_CHUNK:${chunk.id}`) }
}
