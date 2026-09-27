import { createHash } from 'node:crypto'
import { KnowledgeError } from './foundation.js'

export type SourceLocation =
  | { kind: 'page'; pageNumber: number; bbox?: [number, number, number, number] }
  | { kind: 'paragraph'; paragraphId: string }
  | { kind: 'cell'; sheet: string; range: string }

export type BlockType = 'heading' | 'clause' | 'paragraph' | 'table' | 'header' | 'footer'
export interface ParsedBlock {
  id: string
  type: BlockType
  text: string
  sequence: number
  location: SourceLocation
  headingPath: string[]
  sourceSpans: Array<{ start: number; end: number }>
}
export interface ParsedTable {
  id: string
  location: SourceLocation
  headers: string[]
  rows: string[][]
  units: string[]
  continuationOf?: string
}
export interface ParsedSegment {
  sequence: number
  status: 'ok' | 'failed'
  parserName: string
  parserVersion: string
  modelIdentity: string | null
  blocks: ParsedBlock[]
  tables: ParsedTable[]
  originalRef: string
}
export interface SourceSegment {
  sequence: number
  route: 'native' | 'ocr'
  location: SourceLocation
  sourceRef: string
}
export interface ParsedArtifact {
  schemaVersion: 1
  documentId: string
  versionId: string
  buildId: string
  mediaType: 'pdf' | 'word' | 'spreadsheet' | 'image'
  expectedPages: number | null
  segments: ParsedSegment[]
  blocks: ParsedBlock[]
  tables: ParsedTable[]
}
export interface ParserAdapter {
  parse(segment: SourceSegment): Promise<ParsedSegment>
}
export interface QualityIssue {
  code: string
  severity: 'warning' | 'blocking'
  location: SourceLocation | null
  detail: string
}
export interface CleanChange {
  blockId: string
  beforeHash: string
  afterText: string
  ruleVersion: string
  reason: string
}
export interface CleanResult {
  blocks: ParsedBlock[]
  changes: CleanChange[]
  duplicateCandidates: Array<{ firstId: string; secondId: string; kind: 'exact' | 'near' }>
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const validLocation = (location: SourceLocation): boolean => {
  if (location.kind === 'paragraph') return !!location.paragraphId.trim()
  if (location.kind === 'cell') return !!location.sheet.trim() && !!location.range.trim()
  const bbox = location.bbox
  return Number.isSafeInteger(location.pageNumber) && location.pageNumber > 0 &&
    (!bbox || (bbox.length === 4 && bbox.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
      bbox[0] <= bbox[2] && bbox[1] <= bbox[3]))
}
const sameSource = (source: SourceLocation, parsed: SourceLocation): boolean =>
  source.kind === parsed.kind && (source.kind === 'page' && parsed.kind === 'page'
    ? source.pageNumber === parsed.pageNumber : source.kind === 'paragraph' && parsed.kind === 'paragraph'
      ? source.paragraphId === parsed.paragraphId : source.kind === 'cell' && parsed.kind === 'cell'
        ? source.sheet === parsed.sheet && source.range === parsed.range : false)

export async function parseSegments(input: {
  documentId: string; versionId: string; buildId: string
  mediaType: ParsedArtifact['mediaType']; expectedPages: number | null; segments: SourceSegment[]
}, adapters: { native: ParserAdapter; ocr: ParserAdapter }): Promise<ParsedArtifact> {
  if (!input.documentId || !input.versionId || !input.buildId || !Array.isArray(input.segments) ||
      !input.segments.length || !['pdf', 'word', 'spreadsheet', 'image'].includes(input.mediaType) ||
      (input.expectedPages !== null && (!Number.isSafeInteger(input.expectedPages) || input.expectedPages < 1))) {
    throw new KnowledgeError('INVALID_INPUT', '解析输入缺少可信版本或来源段')
  }
  const segments: ParsedSegment[] = []
  for (const source of input.segments) {
    if (!Number.isSafeInteger(source.sequence) || source.sequence < 1 ||
        !['native', 'ocr'].includes(source.route) || !validLocation(source.location) || !source.sourceRef) {
      throw new KnowledgeError('INVALID_INPUT', '来源段位置或引用无效')
    }
    const parsed = await adapters[source.route].parse(source)
    if (parsed.sequence !== source.sequence || parsed.originalRef !== source.sourceRef ||
        !parsed.parserName || !parsed.parserVersion ||
        parsed.blocks.some((block) => !sameSource(source.location, block.location)) ||
        parsed.tables.some((table) => !sameSource(source.location, table.location))) {
      throw new KnowledgeError('PARSER_CONTRACT', '解析器返回的段编号或来源信息无效')
    }
    segments.push(parsed)
  }
  return {
    schemaVersion: 1, documentId: input.documentId, versionId: input.versionId, buildId: input.buildId,
    mediaType: input.mediaType, expectedPages: input.expectedPages, segments,
    blocks: segments.flatMap((segment) => segment.blocks), tables: segments.flatMap((segment) => segment.tables),
  }
}

export function inspectArtifact(artifact: ParsedArtifact): QualityIssue[] {
  const issues: QualityIssue[] = []
  const add = (code: string, severity: QualityIssue['severity'], location: SourceLocation | null, detail: string) =>
    issues.push({ code, severity, location, detail })
  const ordered = [...artifact.segments].sort((a, b) => a.sequence - b.sequence)
  const sequences = new Set<number>()
  for (const segment of ordered) {
    if (sequences.has(segment.sequence)) add('DUPLICATE_SEGMENT', 'blocking', null, `段 ${segment.sequence} 重复`)
    sequences.add(segment.sequence)
    if (segment.status !== 'ok') add('PARSE_FAILED', 'blocking', null, `段 ${segment.sequence} 解析失败`)
    if (segment.status === 'ok' && !segment.blocks.length && !segment.tables.length) {
      add('EMPTY_SEGMENT', 'blocking', null, `段 ${segment.sequence} 无可核对内容`)
    }
  }
  if (ordered.some((segment, index) => segment.sequence !== index + 1)) {
    add('MISSING_SEGMENT', 'blocking', null, '来源段编号不连续')
  }
  if (artifact.expectedPages !== null) {
    const pages = new Set([...artifact.blocks.map((block) => block.location),
      ...artifact.tables.map((table) => table.location)].filter((loc) => loc.kind === 'page').map((loc) => loc.pageNumber))
    if (ordered.length !== artifact.expectedPages || pages.size !== artifact.expectedPages) {
      add('MISSING_PAGE', 'blocking', null, '页数或页面来源不完整')
    }
  }
  const blockIds = new Set<string>()
  for (const segment of artifact.segments) {
    if (segment.blocks.some((block, index) => index > 0 && block.sequence <= segment.blocks[index - 1].sequence)) {
      add('READING_ORDER', 'blocking', null, `段 ${segment.sequence} 阅读顺序不递增`)
    }
  }
  for (const block of artifact.blocks) {
    if (!block.id || blockIds.has(block.id)) add('DUPLICATE_BLOCK', 'blocking', block.location, '块 ID 缺失或重复')
    blockIds.add(block.id)
    if (!validLocation(block.location) || !Number.isSafeInteger(block.sequence) || block.sequence < 1) {
      add('INVALID_LOCATION', 'blocking', block.location, '来源位置或阅读顺序无效')
    }
    if (!block.text.trim() || /\uFFFD|[\u0000-\u0008\u000B\u000E-\u001F]/u.test(block.text)) {
      add('TEXT_CORRUPT', 'blocking', block.location, '文本为空或含异常字符')
    }
    if (!block.sourceSpans.length || block.sourceSpans.some((span) =>
      !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start)) {
      add('SOURCE_SPAN', 'blocking', block.location, '原文范围缺失或无效')
    }
  }
  const tablesById = new Map(artifact.tables.map((table) => [table.id, table]))
  for (const table of artifact.tables) {
    if (!validLocation(table.location) || !table.headers.length || table.headers.some((header) => !header.trim()) ||
        (table.units.length > 0 && table.units.length !== table.headers.length) ||
        table.rows.some((row) => row.length !== table.headers.length)) {
      add('TABLE_STRUCTURE', 'blocking', table.location, '表格表头或列数不完整')
    }
    if (!artifact.blocks.some((block) => block.type === 'table' && sameSource(table.location, block.location))) {
      add('TABLE_BLOCK_MISSING', 'blocking', table.location, '表格没有可切分的结构化文本块')
    }
    if (table.rows.some((row) => row.some((cell) => /\uFFFD/u.test(cell)))) {
      add('TABLE_TEXT_CORRUPT', 'blocking', table.location, '表格单元格存在乱码')
    }
    if (table.continuationOf) {
      const prior = tablesById.get(table.continuationOf)
      if (!prior || JSON.stringify(prior.headers) !== JSON.stringify(table.headers) ||
          JSON.stringify(prior.units) !== JSON.stringify(table.units)) {
        add('TABLE_CONTINUATION', 'blocking', table.location, '跨页表格的前表或表头单位不一致')
      }
    }
  }
  return issues
}

const protectedTokens = (value: string) => [...value.matchAll(/(?:\d[\d,.%]*)|(?:不|无|未|禁止|不得|除外)/gu)].map((match) => match[0]).join('|')
const terms = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])

export function cleanArtifact(artifact: ParsedArtifact): CleanResult {
  const footerPages = new Map<string, Set<number>>()
  for (const block of artifact.blocks) {
    if ((block.type === 'header' || block.type === 'footer') && block.location.kind === 'page') {
      const key = `${block.type}:${block.text.trim()}`
      const pages = footerPages.get(key) ?? new Set<number>()
      pages.add(block.location.pageNumber)
      footerPages.set(key, pages)
    }
  }
  const changes: CleanChange[] = []
  const blocks = artifact.blocks.map((block) => {
    const repeatedNoise = (block.type === 'header' || block.type === 'footer') &&
      (footerPages.get(`${block.type}:${block.text.trim()}`)?.size ?? 0) >= 2 &&
      protectedTokens(block.text) === ''
    const text = repeatedNoise ? '' : block.text.replace(/\s+/gu, ' ').trim()
    if (text !== block.text) changes.push({ blockId: block.id, beforeHash: sha256(block.text), afterText: text,
      ruleVersion: 'p2-clean-v1', reason: repeatedNoise ? '重复页眉页脚' : '空白规范化' })
    return { ...block, text }
  }).filter((block) => block.text.length > 0)
  const duplicateCandidates: CleanResult['duplicateCandidates'] = []
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const left = blocks[i]; const right = blocks[j]
      if (protectedTokens(left.text) !== protectedTokens(right.text)) continue
      if (left.text === right.text) {
        duplicateCandidates.push({ firstId: left.id, secondId: right.id, kind: 'exact' })
      } else {
        const a = terms(left.text); const b = terms(right.text)
        const union = new Set([...a, ...b]).size
        if (union >= 3 && [...a].filter((term) => b.has(term)).length / union >= 0.9) {
          duplicateCandidates.push({ firstId: left.id, secondId: right.id, kind: 'near' })
        }
      }
    }
  }
  return { blocks, changes, duplicateCandidates }
}
