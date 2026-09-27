import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'
import type { ReleasePreview, ReviewKind } from './governance.js'

export interface GovernanceWorkbenchData {
  knowledgeBaseId: string
  canReview: boolean
  canPublish: boolean
  reviewCases: Array<{ caseId: string; kind: ReviewKind; status: string; revision: number;
    leftRef: string; rightRef: string; createdAt: string }>
  proposals: Array<{ proposalId: string; status: string; reason: string;
    preview: ReleasePreview; publishNotBefore: string }>
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

const kindName: Record<ReviewKind, string> = {
  duplicate: '近似重复', conflict: '制度冲突', cleaning: '清洗变更',
}

export async function loadGovernanceWorkbench(context: UntrustedKnowledgeContext,
  knowledgeBaseId: string, database: SqlDatabase,
  identity: KnowledgeIdentityVerifier): Promise<GovernanceWorkbenchData> {
  const actor = await verifyKnowledgeActor(context, identity)
  if (!actor.permissions.includes('review') && !actor.permissions.includes('publish')) {
    throw new KnowledgeError('ACCESS_DENIED', '没有治理工作台访问权限')
  }
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(knowledgeBaseId)) {
    throw new KnowledgeError('INVALID_INPUT', '知识库编号无效')
  }
  const [review, releases] = await Promise.all([
    database.query<{ id: string; kind: ReviewKind; status: string; revision: number;
      left_ref: string; right_ref: string; created_at: string }>(`
      SELECT id, kind, status, revision, left_ref, right_ref, created_at
      FROM hz_p4_review_cases WHERE tenant_id=$1 AND knowledge_base_id=$2
      ORDER BY created_at DESC LIMIT 100`, [actor.tenantId, knowledgeBaseId]),
    database.query<{ id: string; status: string; reason: string;
      preview: ReleasePreview | string; publish_not_before: string }>(`
      SELECT id, status, reason, preview, publish_not_before
      FROM hz_p4_release_proposals WHERE tenant_id=$1 AND knowledge_base_id=$2
      ORDER BY created_at DESC LIMIT 100`, [actor.tenantId, knowledgeBaseId]),
  ])
  return {
    knowledgeBaseId,
    canReview: actor.permissions.includes('review'),
    canPublish: actor.permissions.includes('publish'),
    reviewCases: review.rows.map((row) => ({ caseId: row.id, kind: row.kind, status: row.status,
      revision: Number(row.revision), leftRef: row.left_ref, rightRef: row.right_ref,
      createdAt: new Date(row.created_at).toISOString() })),
    proposals: releases.rows.map((row) => ({ proposalId: row.id, status: row.status,
      reason: row.reason, preview: typeof row.preview === 'string' ? JSON.parse(row.preview) as ReleasePreview : row.preview,
      publishNotBefore: new Date(row.publish_not_before).toISOString() })),
  }
}

export function renderGovernanceWorkbench(data: GovernanceWorkbenchData): string {
  const reviewRows = data.reviewCases.map((item) => `<tr><td>${escapeHtml(kindName[item.kind])}</td>
    <td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.leftRef)}</td>
    <td>${escapeHtml(item.rightRef)}</td><td>${escapeHtml(item.revision)}</td>
    <td>${escapeHtml(item.createdAt)}</td></tr>`).join('')
  const proposalRows = data.proposals.map((item) => `<tr><td>${escapeHtml(item.proposalId)}</td>
    <td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason)}</td>
    <td>新增 ${escapeHtml(item.preview.added.length)} / 移除 ${escapeHtml(item.preview.removed.length)} /
    变更 ${escapeHtml(item.preview.changed.length)} / 保留 ${escapeHtml(item.preview.unchanged.length)}</td>
    <td>${escapeHtml(item.preview.affectedDerivedIds.join('、') || '无')}</td>
    <td>${escapeHtml(item.publishNotBefore)}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>知识治理工作台</title><style>
    body{font:15px/1.6 system-ui,sans-serif;color:#1f2937;background:#f7f9fc;margin:0;padding:2rem}
    main{max-width:1280px;margin:auto}section{background:white;border:1px solid #dce3ed;border-radius:10px;padding:1.25rem;margin:1rem 0}
    table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid #e5e7eb;text-align:left;padding:.65rem;word-break:break-all}
    th{background:#f1f5f9}.scroll{overflow-x:auto}.notice{color:#465569}
    </style></head><body><main><h1>知识治理工作台</h1>
    <p class="notice">知识库 ${escapeHtml(data.knowledgeBaseId)} · 审核权限：${data.canReview ? '有' : '无'} · 发布权限：${data.canPublish ? '有' : '无'}</p>
    <section><h2>清洗审核与制度冲突</h2><p class="notice">展示候选及证据编号；裁决须通过受保护的治理接口提交。</p>
    <div class="scroll"><table><thead><tr><th>类型</th><th>状态</th><th>左侧来源</th><th>右侧来源</th><th>修订</th><th>创建时间</th></tr></thead>
    <tbody>${reviewRows || '<tr><td colspan="6">暂无审核候选</td></tr>'}</tbody></table></div></section>
    <section><h2>版本发布</h2><p class="notice">发布审批需要两人复核；本页仅显示影响预览。</p>
    <div class="scroll"><table><thead><tr><th>提案</th><th>状态</th><th>原因</th><th>版本差异</th><th>受影响派生内容</th><th>计划发布时间</th></tr></thead>
    <tbody>${proposalRows || '<tr><td colspan="6">暂无发布提案</td></tr>'}</tbody></table></div></section>
    </main></body></html>`
}
