import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type UntrustedKnowledgeContext } from './foundation.js'
import type { KnowledgeReadGate, SearchCandidate } from './query.js'
import type { SourceLocation } from './processing.js'

type CitationMetadata = Pick<SearchCandidate, 'tenantId' | 'knowledgeBaseId' | 'documentId' | 'versionId' |
  'buildId' | 'chunkId' | 'title' | 'evidenceType'>
export interface CitationSourceStore {
  getMetadata(input: { documentId: string; versionId: string; buildId: string; chunkId: string }): Promise<CitationMetadata | null>
  getOriginal(input: { documentId: string; versionId: string; buildId: string; chunkId: string }):
    Promise<{ text: string; location: SourceLocation } | null>
}
export interface OpenedCitation {
  sourceRef: string; documentId: string; versionId: string; buildId: string; chunkId: string
  title: string; content: string; location: SourceLocation; effectiveFrom: string | null; effectiveTo: string | null
}
const sourcePattern = /^knowledge:([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,128})$/

export class KnowledgeCitationResolver {
  constructor(private readonly identity: KnowledgeIdentityVerifier, private readonly gate: KnowledgeReadGate,
    private readonly store: CitationSourceStore) {}

  async open(context: UntrustedKnowledgeContext, sourceRef: string): Promise<OpenedCitation> {
    const match = typeof sourceRef === 'string' ? sourceRef.match(sourcePattern) : null
    if (!match) throw new KnowledgeError('INVALID_SOURCE_REF', '知识来源编号无效')
    const actor = await verifyKnowledgeActor(context, this.identity)
    const input = { documentId: match[1], versionId: match[2], buildId: match[3], chunkId: match[4] }
    const metadata = await this.store.getMetadata(input)
    if (!metadata || metadata.tenantId !== actor.tenantId ||
        metadata.documentId !== input.documentId || metadata.versionId !== input.versionId ||
        metadata.buildId !== input.buildId || metadata.chunkId !== input.chunkId ||
        !['original_text', 'table_cell'].includes(metadata.evidenceType)) {
      throw new KnowledgeError('ACCESS_DENIED', '来源当前不可读取')
    }
    const read = { knowledgeBaseId: metadata.knowledgeBaseId, documentId: input.documentId,
      versionId: input.versionId, buildId: input.buildId, surface: 'citation' as const }
    const before = await this.gate.authorizeRead(context, read)
    const original = await this.store.getOriginal(input)
    if (!original?.text?.trim() || !original.location) throw new KnowledgeError('ACCESS_DENIED', '来源当前不可读取')
    const after = await this.gate.authorizeRead(context, read)
    if (before.releaseId !== after.releaseId || before.epoch !== after.epoch ||
        before.aclRevision !== after.aclRevision) throw new KnowledgeError('SOURCE_CHANGED', '来源状态已改变，请重新查询')
    return { sourceRef, ...input, title: metadata.title, content: original.text, location: original.location,
      effectiveFrom: after.effectiveFrom ?? null, effectiveTo: after.effectiveTo ?? null }
  }
}
