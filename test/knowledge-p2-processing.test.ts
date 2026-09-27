import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanArtifact, inspectArtifact, parseSegments, type ParsedArtifact, type ParsedBlock } from '../src/knowledge/processing.js'
import { splitIntoChunks } from '../src/knowledge/chunking.js'
import { embedChunks, EmbeddingProviderError } from '../src/knowledge/embedding.js'

const page = (pageNumber: number) => ({ kind: 'page' as const, pageNumber })
const block = (id: string, text: string, pageNumber: number, type: ParsedBlock['type'] = 'paragraph'): ParsedBlock => ({
  id, type, text, sequence: pageNumber, location: page(pageNumber), headingPath: [],
  sourceSpans: [{ start: 0, end: text.length }],
})
const artifact = (blocks: ParsedBlock[]): ParsedArtifact => ({
  schemaVersion: 1, documentId: 'doc', versionId: 'version', buildId: 'build', mediaType: 'pdf', expectedPages: 2,
  segments: [1, 2].map((sequence) => ({ sequence, status: 'ok', parserName: 'fixture', parserVersion: '1',
    modelIdentity: null, originalRef: `private://page/${sequence}`,
    blocks: blocks.filter((item) => item.location.kind === 'page' && item.location.pageNumber === sequence), tables: [] })),
  blocks, tables: [],
})

test('逐页路由原生和 OCR，保留来源并发现漏页与坏表格', async () => {
  const calls: string[] = []
  const result = await parseSegments({ documentId: 'doc', versionId: 'ver', buildId: 'build', mediaType: 'pdf',
    expectedPages: 2, segments: [
      { sequence: 1, route: 'native', location: page(1), sourceRef: 'private://p1' },
      { sequence: 2, route: 'ocr', location: page(2), sourceRef: 'private://p2' },
    ] }, {
    native: { parse: async (source) => { calls.push('native'); return { sequence: source.sequence, status: 'ok',
      parserName: 'native', parserVersion: '1', modelIdentity: null, originalRef: source.sourceRef,
      blocks: [block('a', '第一条 不得超过500元', 1)], tables: [] } } },
    ocr: { parse: async (source) => { calls.push('ocr'); return { sequence: source.sequence, status: 'ok',
      parserName: 'ocr-api', parserVersion: '1', modelIdentity: 'ocr-v1', originalRef: source.sourceRef,
      blocks: [block('b', '报销表 金额 元', 2, 'table')],
      tables: [{ id: 't1', location: page(2), headers: ['项目', '金额'], rows: [['差旅', '500']], units: ['', '元'] }] } } },
  })
  assert.deepEqual(calls, ['native', 'ocr'])
  assert.deepEqual(inspectArtifact(result), [])
  const damaged = { ...result, expectedPages: 3, tables: [{ ...result.tables[0], headers: [] }] }
  assert.deepEqual(inspectArtifact(damaged).map((issue) => issue.code), ['MISSING_PAGE', 'TABLE_STRUCTURE'])
  await assert.rejects(parseSegments({ documentId: 'doc', versionId: 'ver', buildId: 'build', mediaType: 'pdf',
    expectedPages: 1, segments: [{ sequence: 1, route: 'ocr', location: page(1), sourceRef: 'private://p1' }] },
  { native: { parse: async () => result.segments[0] },
    ocr: { parse: async () => ({ ...result.segments[0], originalRef: 'private://other' }) } }),
  { code: 'PARSER_CONTRACT' })
  const continuation = { ...result, tables: [{ ...result.tables[0], continuationOf: 'missing' }] }
  assert.ok(inspectArtifact(continuation).some((issue) => issue.code === 'TABLE_CONTINUATION'))
})

test('Word 段落和表格单元格使用真实定位类型，不伪造页码', async () => {
  const paragraph = { kind: 'paragraph' as const, paragraphId: 'clause-1' }
  const word = await parseSegments({ documentId: 'doc', versionId: 'ver', buildId: 'build', mediaType: 'word',
    expectedPages: null, segments: [{ sequence: 1, route: 'native', location: paragraph,
      sourceRef: 'private://word/paragraph-1' }] }, {
    native: { parse: async (source) => ({ sequence: 1, status: 'ok', parserName: 'word-native', parserVersion: '1',
      modelIdentity: null, originalRef: source.sourceRef, blocks: [{ id: 'word-1', type: 'clause', text: '合同条款',
        sequence: 1, location: paragraph, headingPath: ['第一条'], sourceSpans: [{ start: 0, end: 4 }] }], tables: [] }) },
    ocr: { parse: async () => { throw new Error('不应调用 OCR') } },
  })
  assert.equal(word.blocks[0].location.kind, 'paragraph')
  assert.deepEqual(inspectArtifact(word), [])
  const cell = { kind: 'cell' as const, sheet: '费用', range: 'A1:B2' }
  const sheet = await parseSegments({ documentId: 'doc', versionId: 'ver', buildId: 'build', mediaType: 'spreadsheet',
    expectedPages: null, segments: [{ sequence: 1, route: 'native', location: cell,
      sourceRef: 'private://sheet/A1:B2' }] }, {
    native: { parse: async (source) => ({ sequence: 1, status: 'ok', parserName: 'sheet-native', parserVersion: '1',
      modelIdentity: null, originalRef: source.sourceRef, blocks: [{ id: 'table-block-1', type: 'table',
        text: '项目 金额(元)\n差旅 500', sequence: 1, location: cell, headingPath: ['费用'],
        sourceSpans: [{ start: 0, end: 18 }] }],
      tables: [{ id: 'table-1', location: cell, headers: ['项目', '金额'], rows: [['差旅', '500']], units: ['', '元'] }] }) },
    ocr: { parse: async () => { throw new Error('不应调用 OCR') } },
  })
  assert.equal(sheet.tables[0].location.kind, 'cell')
  assert.deepEqual(inspectArtifact(sheet), [])
})

test('清洗只处理可记录噪声，数字和否定词差异保留为独立正文', () => {
  const parsed = artifact([
    block('h1', '内部资料', 1, 'header'), block('c1', '不得超过 500 元', 1, 'clause'),
    block('h2', '内部资料', 2, 'header'), block('c2', '不得超过 800 元', 2, 'clause'),
    block('f1', '不得擅自修改 500 元上限', 1, 'footer'),
    block('f2', '不得擅自修改 500 元上限', 2, 'footer'),
    block('d1', '合同附件 完整条款', 2), block('d2', '合同附件 完整条款', 2),
  ])
  const result = cleanArtifact(parsed)
  assert.deepEqual(result.blocks.map((item) => item.id), ['c1', 'c2', 'f1', 'f2', 'd1', 'd2'])
  assert.ok(result.changes.some((change) => change.blockId === 'h1' && change.beforeHash.length === 64))
  assert.ok(result.duplicateCandidates.some((candidate) => candidate.firstId === 'd1' && candidate.secondId === 'd2'))
  assert.ok(result.blocks.some((item) => item.text === '不得超过 500 元'))
  assert.ok(result.blocks.some((item) => item.text === '不得超过 800 元'))
})

test('语义模型只能返回已有边界；错误边界回退并保持父子覆盖', async () => {
  const blocks = [block('a', '第一条 不得 报销', 1, 'clause'), block('b', '例外 需 审批', 1, 'clause'),
    block('c', '第二条 限额 500', 2, 'clause')]
  const counter = { count: (text: string) => text.split(/\s+/u).filter(Boolean).length }
  const result = await splitIntoChunks({ buildId: 'build', blocks, maxChildTokens: 7, maxParentTokens: 12,
    minChildTokens: 1, tokenCounter: counter,
    boundaryModel: { propose: async () => ({ beforeBlockIds: ['invented'], modelIdentity: 'semantic-v1' }) } })
  assert.equal(result.fallbackReason, 'SEMANTIC_BOUNDARY_INVALID')
  assert.deepEqual(result.chunks.flatMap((chunk) => chunk.blockIds), ['a', 'b', 'c'])
  assert.ok(result.chunks.every((chunk) => result.parents.some((parent) => parent.id === chunk.parentId)))
  await assert.rejects(splitIntoChunks({ buildId: 'build', blocks: [block('long', 'a b c d e f g h', 1)],
    maxChildTokens: 3, maxParentTokens: 5, minChildTokens: 1, tokenCounter: counter,
    boundaryModel: { propose: async () => ({ beforeBlockIds: [], modelIdentity: 'semantic-v1' }) } }),
  { code: 'CHUNK_TOO_LARGE' })
})

test('Embedding 按 token 批量、只重试临时错误、校验模型维度并复用缓存', async () => {
  const chunks = [block('a', '甲 乙', 1), block('b', '丙 丁', 2)].map((source) => ({
    id: source.id, parentId: 'parent', blockIds: [source.id], locations: [source.location],
    text: source.text, tokenCount: 2,
  }))
  const values = new Map<string, number[]>()
  const cache = { get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, vector: number[]) => { values.set(key, vector) } }
  let calls = 0
  const input = { tenantId: 7, chunks, modelIdentity: 'embedding-v1', dimensions: 2,
    maxBatchItems: 1, maxBatchTokens: 2, maxAttempts: 2, cache, delay: async () => undefined }
  const provider = { embed: async ({ items, modelIdentity }: { items: Array<{ id: string; text: string }>; modelIdentity: string }) => {
    calls++
    if (calls === 1) throw new EmbeddingProviderError('429', true, 1)
    return { modelIdentity, vectors: items.map((item) => ({ id: item.id, values: [1, 2] })) }
  } }
  assert.equal((await embedChunks({ ...input, provider })).length, 2)
  assert.equal(calls, 3)
  await embedChunks({ ...input, provider })
  assert.equal(calls, 3)
  await assert.rejects(embedChunks({ ...input, cache: { get: async () => null, put: async () => undefined },
    provider: { embed: async ({ items }) => ({ modelIdentity: 'embedding-v1',
      vectors: items.map((item) => ({ id: item.id, values: [Number.NaN, 2] })) }) } }),
  { code: 'EMBEDDING_RESPONSE_INVALID' })
  const writes: string[] = []
  await assert.rejects(embedChunks({ ...input, maxBatchItems: 2, maxBatchTokens: 4,
    cache: { get: async () => null, put: async (key) => { writes.push(key) } },
    provider: { embed: async ({ items }) => ({ modelIdentity: 'embedding-v1',
      vectors: items.map((item, index) => ({ id: item.id, values: index ? [1, Number.NaN] : [1, 2] })) }) } }),
  { code: 'EMBEDDING_RESPONSE_INVALID' })
  assert.deepEqual(writes, [])
})
