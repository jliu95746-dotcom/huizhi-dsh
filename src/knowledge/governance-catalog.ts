import { createHash, randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type SqlSession, type UntrustedKnowledgeContext } from './foundation.js'
import { findRuleConflicts, validateRuleSuggestion, type GovernanceRule } from './governance-policy.js'
import type { ReviewEvidenceStore } from './governance.js'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const sourcePattern = /^knowledge:([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,36}):([A-Za-z0-9_-]{1,128})$/
const record = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
const valid = (value: string, name: string, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 无效`)
  }
  return value.trim()
}

export class KnowledgeCatalog {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly evidence: ReviewEvidenceStore) {}

  private async sourceDocument(tenantId: number, kb: string, ref: string,
    session: SqlSession = this.database): Promise<string> {
    const match = ref.match(sourcePattern)
    if (!match) throw new KnowledgeError('INVALID_SOURCE_REF', '来源编号无效')
    const result = await session.query(`SELECT d.id FROM hz_documents d
      JOIN hz_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      JOIN hz_builds b ON b.tenant_id=v.tenant_id AND b.version_id=v.id
      WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3 AND v.id=$4 AND b.id=$5`,
    [tenantId, kb, match[1], match[2], match[3]])
    if (!result.rows.length) throw new KnowledgeError('ACCESS_DENIED', '来源不可访问')
    return match[1]
  }

  async createEntity(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    canonicalName: string; entityType: string }): Promise<{ entityId: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const kb = valid(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const name = valid(input.canonicalName, 'canonicalName')
    const type = valid(input.entityType, 'entityType', 64)
    const id = randomUUID()
    const inserted = await this.database.query<{ id: string }>(`INSERT INTO hz_p4_entities
      (id, tenant_id, knowledge_base_id, canonical_name, entity_type, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, knowledge_base_id, entity_type, canonical_name) DO NOTHING RETURNING id`,
    [id, actor.tenantId, kb, name, type, actor.requesterId])
    if (inserted.rows.length) return { entityId: id }
    const prior = (await this.database.query<{ id: string }>(`SELECT id FROM hz_p4_entities
      WHERE tenant_id=$1 AND knowledge_base_id=$2 AND entity_type=$3 AND canonical_name=$4`,
    [actor.tenantId, kb, type, name])).rows[0]
    return { entityId: prior.id }
  }

  async addEntityAlias(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    entityId: string; alias: string; sourceRef: string }): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const kb = valid(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const entityId = valid(input.entityId, 'entityId', 36)
    const alias = valid(input.alias, 'alias')
    const entity = await this.database.query(`SELECT id FROM hz_p4_entities WHERE tenant_id=$1
      AND knowledge_base_id=$2 AND id=$3`, [actor.tenantId, kb, entityId])
    if (!entity.rows.length) throw new KnowledgeError('ACCESS_DENIED', '标准实体不可访问')
    await this.sourceDocument(actor.tenantId, kb, input.sourceRef)
    const text = await this.evidence.loadText(input.sourceRef)
    if (!text?.includes(alias)) throw new KnowledgeError('ALIAS_NOT_IN_SOURCE', '别名未出现在来源原文中')
    await this.database.query(`INSERT INTO hz_p4_entity_aliases
      (id, tenant_id, knowledge_base_id, entity_id, alias, source_ref, confirmed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, knowledge_base_id, entity_id, alias) DO NOTHING`,
    [randomUUID(), actor.tenantId, kb, entityId, alias, input.sourceRef, actor.requesterId])
  }

  async resolveEntity(context: UntrustedKnowledgeContext, knowledgeBaseId: string, alias: string): Promise<Array<{
    entityId: string; canonicalName: string; entityType: string
  }>> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const kb = valid(knowledgeBaseId, 'knowledgeBaseId', 36)
    const name = valid(alias, 'alias')
    const rows = (await this.database.query<{ id: string; canonical_name: string; entity_type: string }>(`
      SELECT DISTINCT e.id, e.canonical_name, e.entity_type FROM hz_p4_entities e
      LEFT JOIN hz_p4_entity_aliases a ON a.tenant_id=e.tenant_id AND a.entity_id=e.id
      WHERE e.tenant_id=$1 AND e.knowledge_base_id=$2 AND (e.canonical_name=$3 OR a.alias=$3)
      ORDER BY e.canonical_name, e.id`, [actor.tenantId, kb, name])).rows
    return rows.map((row) => ({ entityId: row.id, canonicalName: row.canonical_name, entityType: row.entity_type }))
  }

  async submitRuleSuggestion(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    rule: Omit<GovernanceRule, 'id'> }): Promise<{ ruleId: string }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'ingest')
    const kb = valid(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const ruleId = randomUUID()
    if (input.rule.approvedExceptionOf) {
      throw new KnowledgeError('UNAPPROVED_EXCEPTION', '模型建议不能自行声明已批准例外')
    }
    const rule: GovernanceRule = { ...input.rule, id: ruleId }
    const check = validateRuleSuggestion(rule)
    if (!check.ok) throw new KnowledgeError(check.reason, '规则建议缺少可信原文支持')
    await this.sourceDocument(actor.tenantId, kb, rule.sourceRef)
    const original = await this.evidence.loadText(rule.sourceRef)
    if (!original || original !== rule.originalText) {
      throw new KnowledgeError('RULE_SOURCE_MISMATCH', '规则原文与保存的来源不一致')
    }
    await this.database.query(`INSERT INTO hz_p4_rule_suggestions
      (id, tenant_id, knowledge_base_id, source_ref, rule_data, created_by)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [ruleId, actor.tenantId, kb, rule.sourceRef, JSON.stringify(rule), actor.requesterId])
    return { ruleId }
  }

  async confirmRuleSuggestion(context: UntrustedKnowledgeContext, ruleId: string): Promise<{ conflictCaseIds: string[] }> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'review')
    const id = valid(ruleId, 'ruleId', 36)
    return this.database.transaction(async (tx) => {
      const saved = (await tx.query<{ knowledge_base_id: string; rule_data: GovernanceRule;
        status: string; created_by: string }>(`SELECT knowledge_base_id, rule_data, status, created_by
        FROM hz_p4_rule_suggestions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, id])).rows[0]
      if (!saved) throw new KnowledgeError('ACCESS_DENIED', '规则建议不可访问')
      if (saved.status !== 'candidate') throw new KnowledgeError('REVIEW_CONFLICT', '规则建议已处理')
      if (saved.created_by === actor.requesterId) throw new KnowledgeError('SELF_REVIEW_DENIED', '建议提交人不能自行确认')
      const rule = record<GovernanceRule>(saved.rule_data)
      const original = await this.evidence.loadText(rule.sourceRef)
      if (!original || original !== rule.originalText || !validateRuleSuggestion(rule).ok) {
        throw new KnowledgeError('RULE_SOURCE_MISMATCH', '规则原文已变化')
      }
      const existing = (await tx.query<{ rule_data: GovernanceRule }>(`SELECT rule_data FROM hz_p4_rule_suggestions
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status='confirmed'`,
      [actor.tenantId, saved.knowledge_base_id])).rows.map((row) => record<GovernanceRule>(row.rule_data))
      const conflicts = findRuleConflicts([...existing, rule]).filter((item) => item.right.id === rule.id)
      const conflictCaseIds: string[] = []
      for (const conflict of conflicts) {
        const left = await this.evidence.loadText(conflict.left.sourceRef)
        if (!left || left !== conflict.left.originalText) throw new KnowledgeError('RULE_SOURCE_MISMATCH', '既有规则原文已变化')
        const leftDoc = await this.sourceDocument(actor.tenantId, saved.knowledge_base_id, conflict.left.sourceRef, tx)
        const rightDoc = await this.sourceDocument(actor.tenantId, saved.knowledge_base_id, rule.sourceRef, tx)
        const caseId = randomUUID()
        await tx.query(`INSERT INTO hz_p4_review_cases
          (id, tenant_id, knowledge_base_id, kind, left_ref, right_ref, left_hash, right_hash, document_ids, created_by)
          VALUES ($1,$2,$3,'conflict',$4,$5,$6,$7,$8::jsonb,$9)`,
        [caseId, actor.tenantId, saved.knowledge_base_id, conflict.left.sourceRef, rule.sourceRef,
          sha256(left), sha256(original), JSON.stringify([...new Set([leftDoc, rightDoc])]), actor.requesterId])
        conflictCaseIds.push(caseId)
      }
      await tx.query(`UPDATE hz_p4_rule_suggestions SET status='confirmed', confirmed_by=$3
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, id, actor.requesterId])
      return { conflictCaseIds }
    })
  }
}
