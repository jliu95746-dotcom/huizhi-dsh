import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier, type ReadSurface,
  type UntrustedKnowledgeContext } from './foundation.js'
import type { SourceLocation } from './processing.js'

export type SearchStatus = 'ok' | 'no_evidence' | 'needs_clarification' | 'unresolved_conflict' | 'degraded'
export type RetrievalMode = 'keyword' | 'vector' | 'exactNumber'
export interface QueryPlan {
  original: string
  queries: string[]
  intent: 'explain' | 'compare' | 'calculate'
  temporalExpression: string | null
  department: string | null
  documentNumber: string | null
  amount: string | null
  needsClarification: boolean
  clarificationReason: 'ambiguous_reference' | 'historical_time' | null
}

const numberPattern = /(?:[A-Za-z]{2,}[-－])?\d{4}[-－]\d{1,8}|[A-Za-z]{2,}[-－]\d{2,}/
const timePattern = /\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?/
const departmentPattern = /[\u4e00-\u9fa5]{2,12}(?:部|中心|事业部)/
const amountPattern = /\d+(?:\.\d+)?\s*(?:元|万元|亿元)/

export function planKnowledgeQuery(query: string, now: Date = new Date()): QueryPlan {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
    throw new KnowledgeError('INVALID_INPUT', '问题不能为空且不能超过 2000 字')
  }
  const original = query.trim()
  const temporalExpression = original.match(timePattern)?.[0] ?? null
  const department = original.match(departmentPattern)?.[0] ?? null
  const documentNumber = original.match(numberPattern)?.[0] ?? null
  const amount = original.match(amountPattern)?.[0] ?? null
  const intent = /合计|总计|平均|多少条|统计/.test(original) ? 'calculate' :
    /对比|比较|区别|变化/.test(original) ? 'compare' : 'explain'
  const ambiguousReference = /^(?:它|这个|那个|上述|该文件|该制度)/.test(original) &&
    !documentNumber && !department && !temporalExpression
  const timeParts = temporalExpression?.match(/^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/)
  const historicalTime = !!timeParts && (Number(timeParts[1]) !== now.getUTCFullYear() ||
    !!timeParts[2] && Number(timeParts[2]) !== now.getUTCMonth() + 1 ||
    !!timeParts[3] && Number(timeParts[3]) !== now.getUTCDate())
  const clarificationReason = historicalTime ? 'historical_time' : ambiguousReference ? 'ambiguous_reference' : null
  const needsClarification = clarificationReason !== null
  const queries = [original]
  const synonym = original.replace(/住宿费/g, '住宿').replace(/报销标准/g, '报销规则')
  if (synonym !== original && !queries.includes(synonym)) queries.push(synonym)
  return { original, queries, intent, temporalExpression, department, documentNumber, amount,
    needsClarification, clarificationReason }
}

export interface SearchCandidate {
  tenantId: number
  knowledgeBaseId: string
  documentId: string
  versionId: string
  buildId: string
  chunkId: string
  parentId?: string
  title: string
  text: string
  location: SourceLocation
  evidenceType: 'original_text' | 'table_cell' | 'generated_summary'
  conflictStatus: 'none' | 'unresolved'
  effectiveFrom: string
  effectiveTo: string | null
  score: number
}
export interface CandidateRetrievers {
  keyword(input: { tenantId: number; plan: QueryPlan; limit: number }): Promise<SearchCandidate[]>
  vector(input: { tenantId: number; plan: QueryPlan; limit: number }): Promise<SearchCandidate[]>
  exactNumber(input: { tenantId: number; plan: QueryPlan; limit: number }): Promise<SearchCandidate[]>
}
export interface CandidateReranker {
  rerank(query: string, candidates: SearchCandidate[]): Promise<Array<{ candidateKey: string; score: number }>>
}
export interface ParentChunkReader {
  getParent(candidate: SearchCandidate): Promise<SearchCandidate | null>
}
export interface KnowledgeReadGate {
  authorizeRead(context: UntrustedKnowledgeContext, input: {
    knowledgeBaseId: string; documentId: string; versionId: string; buildId: string; surface: ReadSurface; asOf?: string
  }): Promise<{ releaseId: string; epoch: number; aclRevision: number;
    effectiveFrom?: string; effectiveTo?: string | null }>
}
export interface ModelDataPolicy {
  allow(context: UntrustedKnowledgeContext, purpose: 'vector_query' | 'rerank', candidates: SearchCandidate[]): Promise<boolean>
}
export interface EvidenceHit {
  documentId: string; version: string; buildId: string; chunkId: string; title: string; content: string
  sourceRef: string; location: SourceLocation; effectiveFrom: string; effectiveTo: string | null
  evidenceType: SearchCandidate['evidenceType']; conflictStatus: SearchCandidate['conflictStatus']
  parentContext?: string
  knowledgeBaseId: string
  retrievalModes: RetrievalMode[]
  retrievalScore: number
  rerankScore: number
}
export interface KnowledgeSearchResult {
  schemaVersion: 1; sourceRef: string; version: string; status: SearchStatus; traceId: string
  hits: EvidenceHit[]; message: string
  diagnostics: { recalled: Record<RetrievalMode, number>; authorized: number; filtered: number;
    rerankStatus: 'ok' | 'unavailable' | 'skipped'; lowRelevance: number }
}

const explanations: Record<SearchStatus, string> = {
  ok: '已找到可核验的资料。', no_evidence: '当前资料不足，无法给出确定答案。',
  needs_clarification: '请补充所指的制度、合同或文档编号。',
  unresolved_conflict: '检索到尚未裁决的冲突规则，请人工确认适用版本。',
  degraded: '检索或重排服务暂时不可用，当前不能给出确定答案。',
}
export const candidateKey = (item: SearchCandidate) => [item.tenantId, item.knowledgeBaseId, item.documentId,
  item.versionId, item.buildId, item.chunkId].join(':')
const evidenceRef = (item: SearchCandidate) => `knowledge:${item.documentId}:${item.versionId}:${item.buildId}:${item.chunkId}`
const source = (item: SearchCandidate, surface: ReadSurface) => ({ knowledgeBaseId: item.knowledgeBaseId,
  documentId: item.documentId, versionId: item.versionId, buildId: item.buildId, surface })
const denied = (error: unknown) => error instanceof KnowledgeError && error.code === 'ACCESS_DENIED' ||
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ACCESS_DENIED'

export class KnowledgeQueryService {
  constructor(private readonly identity: KnowledgeIdentityVerifier, private readonly gate: KnowledgeReadGate,
    private readonly retrievers: CandidateRetrievers, private readonly reranker: CandidateReranker,
    private readonly parents?: ParentChunkReader, private readonly policy?: ModelDataPolicy,
    private readonly minRerankScore = 0.5) {
    if (!(minRerankScore >= 0 && minRerankScore <= 1)) throw new KnowledgeError('INVALID_INPUT', '重排阈值无效')
  }

  private async allowed(context: UntrustedKnowledgeContext, candidate: SearchCandidate, surface: ReadSurface): Promise<boolean> {
    try { await this.gate.authorizeRead(context, source(candidate, surface)); return true }
    catch (error) { if (denied(error)) return false; throw error }
  }

  private async readSnapshot(context: UntrustedKnowledgeContext, candidate: SearchCandidate, surface: ReadSurface) {
    try { return await this.gate.authorizeRead(context, source(candidate, surface)) }
    catch (error) { if (denied(error)) return null; throw error }
  }

  async authorizeCitation(context: UntrustedKnowledgeContext, hit: EvidenceHit): Promise<boolean> {
    try {
      await verifyKnowledgeActor(context, this.identity)
      await this.gate.authorizeRead(context, { knowledgeBaseId: hit.knowledgeBaseId, documentId: hit.documentId,
        versionId: hit.version, buildId: hit.buildId, surface: 'citation' })
      return true
    } catch (error) { if (denied(error)) return false; throw error }
  }

  async search(context: UntrustedKnowledgeContext, question: string): Promise<KnowledgeSearchResult> {
    const actor = await verifyKnowledgeActor(context, this.identity)
    const plan = planKnowledgeQuery(question)
    const traceId = context.taskId || randomUUID()
    const diagnostics: KnowledgeSearchResult['diagnostics'] = { recalled: { keyword: 0, vector: 0, exactNumber: 0 },
      authorized: 0, filtered: 0, rerankStatus: 'skipped', lowRelevance: 0 }
    const finish = (status: SearchStatus, hits: EvidenceHit[] = [], snapshot = 'none'): KnowledgeSearchResult => ({
      schemaVersion: 1, sourceRef: `knowledge-query:${createHash('sha256').update(JSON.stringify([traceId, snapshot,
        hits.map((hit) => hit.sourceRef)])).digest('hex')}`, version: snapshot, status, traceId, hits,
      message: explanations[status], diagnostics,
    })
    if (plan.needsClarification) {
      const result = finish('needs_clarification')
      if (plan.clarificationReason === 'historical_time') {
        result.message = '历史或未来时点查询需要可信查询时间与相应授权，当前不能按现行版本回答。'
      }
      return result
    }
    const limit = 20
    const fetched: Array<[RetrievalMode, SearchCandidate[]]> = []
    try {
      fetched.push(['keyword', await this.retrievers.keyword({ tenantId: actor.tenantId, plan, limit })])
      fetched.push(['exactNumber', await this.retrievers.exactNumber({ tenantId: actor.tenantId, plan, limit })])
      if (await this.policy?.allow(context, 'vector_query', []) === true) {
        fetched.push(['vector', await this.retrievers.vector({ tenantId: actor.tenantId, plan, limit })])
      }
    } catch { return finish('degraded') }
    const combined = new Map<string, { item: SearchCandidate; modes: RetrievalMode[] }>()
    for (const [mode, items] of fetched) {
      if (!Array.isArray(items) || items.length > limit) return finish('degraded')
      diagnostics.recalled[mode] = items.length
      for (const item of items) {
        if (item.tenantId !== actor.tenantId || !item.text?.trim() || item.text.length > 12000 || !item.chunkId ||
            !Number.isFinite(item.score) || item.score < 0 || item.score > 1 || !item.location) {
          diagnostics.filtered++; continue
        }
        const key = candidateKey(item)
        const prior = combined.get(key)
        if (prior) { if (!prior.modes.includes(mode)) prior.modes.push(mode); continue }
        combined.set(key, { item, modes: [mode] })
      }
    }
    const candidates: Array<{ item: SearchCandidate; modes: RetrievalMode[] }> = []
    for (const entry of combined.values()) {
      if (await this.allowed(context, entry.item, 'search')) candidates.push(entry)
      else diagnostics.filtered++
    }
    diagnostics.authorized = candidates.length
    if (!candidates.length) return finish('no_evidence')
    const beforeRerank: typeof candidates = []
    for (const entry of candidates) {
      if (await this.allowed(context, entry.item, 'original')) beforeRerank.push(entry)
      else diagnostics.filtered++
    }
    if (!beforeRerank.length) return finish('no_evidence')
    let rerankAllowed = false
    try { rerankAllowed = await this.policy?.allow(context, 'rerank', beforeRerank.map((entry) => entry.item)) === true }
    catch { rerankAllowed = false }
    if (!rerankAllowed) {
      diagnostics.rerankStatus = 'unavailable'; return finish('degraded')
    }
    let ranked: Array<{ candidateKey: string; score: number }>
    try { ranked = await this.reranker.rerank(plan.original, beforeRerank.map((entry) => entry.item)) }
    catch { diagnostics.rerankStatus = 'unavailable'; return finish('degraded') }
    if (!Array.isArray(ranked) || ranked.length !== beforeRerank.length ||
        new Set(ranked.map((item) => item.candidateKey)).size !== ranked.length || ranked.some((item) =>
          !beforeRerank.some((entry) => candidateKey(entry.item) === item.candidateKey) ||
          !Number.isFinite(item.score) || item.score < 0 || item.score > 1)) {
      diagnostics.rerankStatus = 'unavailable'; return finish('degraded')
    }
    diagnostics.rerankStatus = 'ok'
    const scores = new Map(ranked.map((item) => [item.candidateKey, item.score]))
    const selected = beforeRerank.filter((entry) => (scores.get(candidateKey(entry.item)) ?? 0) >= this.minRerankScore)
      .sort((a, b) => (scores.get(candidateKey(b.item)) ?? 0) - (scores.get(candidateKey(a.item)) ?? 0)).slice(0, 8)
    diagnostics.lowRelevance = beforeRerank.length - selected.length
    if (!selected.length) return finish('no_evidence')
    const hits: EvidenceHit[] = []
    const snapshots = new Set<string>()
    const perBase = new Map<string, string>()
    let contentLength = 0
    for (const { item, modes } of selected) {
      if (contentLength + item.text.length > 12000) { diagnostics.filtered++; continue }
      let parentContext: string | undefined
      if (this.parents && item.parentId) {
        const parent = await this.parents.getParent(item)
        if (parent && parent.tenantId === item.tenantId && parent.knowledgeBaseId === item.knowledgeBaseId &&
            parent.documentId === item.documentId && parent.versionId === item.versionId &&
            parent.buildId === item.buildId && parent.chunkId === item.parentId &&
            parent.text.length <= 4000 && await this.allowed(context, parent, 'parent')) parentContext = parent.text
      }
      const snapshot = await this.readSnapshot(context, item, 'citation')
      if (!snapshot) { diagnostics.filtered++; continue }
      const snapshotKey = `${item.knowledgeBaseId}:${snapshot.releaseId}:${snapshot.epoch}:${snapshot.aclRevision}`
      if (perBase.has(item.knowledgeBaseId) && perBase.get(item.knowledgeBaseId) !== snapshotKey) return finish('degraded')
      perBase.set(item.knowledgeBaseId, snapshotKey)
      snapshots.add(snapshotKey)
      contentLength += item.text.length
      hits.push({ documentId: item.documentId, version: item.versionId, buildId: item.buildId, chunkId: item.chunkId,
        title: item.title, content: item.text, sourceRef: evidenceRef(item), location: item.location,
        effectiveFrom: snapshot.effectiveFrom ?? item.effectiveFrom,
        effectiveTo: snapshot.effectiveTo === undefined ? item.effectiveTo : snapshot.effectiveTo,
        evidenceType: item.evidenceType,
        conflictStatus: item.conflictStatus, knowledgeBaseId: item.knowledgeBaseId, retrievalModes: modes,
        retrievalScore: item.score, rerankScore: scores.get(candidateKey(item))!, ...(parentContext ? { parentContext } : {}) })
    }
    if (!hits.length) return finish('no_evidence')
    const snapshot = createHash('sha256').update([...snapshots].sort().join('|')).digest('hex')
    return finish(hits.some((hit) => hit.conflictStatus === 'unresolved') ? 'unresolved_conflict' : 'ok', hits, snapshot)
  }
}
