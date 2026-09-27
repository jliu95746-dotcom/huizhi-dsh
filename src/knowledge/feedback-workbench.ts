import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'

export interface FeedbackWorkbenchData {
  knowledgeBaseId: string
  datasetRevision: number
  feedback: Array<{ id: string; category: string; status: string; comment: string;
    traceId: string; createdAt: string }>
  runs: Array<{ id: string; status: string; caseCount: number;
    configFingerprint: string; approvedBy: string | null; createdAt: string }>
}
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

export async function loadFeedbackWorkbench(context: UntrustedKnowledgeContext,
  knowledgeBaseId: string, database: SqlDatabase,
  identity: KnowledgeIdentityVerifier): Promise<FeedbackWorkbenchData> {
  const actor = await verifyKnowledgeActor(context, identity, 'review')
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(knowledgeBaseId)) {
    throw new KnowledgeError('INVALID_INPUT', '知识库编号无效')
  }
  const [state, feedback, runs] = await Promise.all([
    database.query<{ revision: number }>(`SELECT revision FROM hz_p5_dataset_state
      WHERE tenant_id=$1 AND knowledge_base_id=$2`, [actor.tenantId, knowledgeBaseId]),
    database.query<{ id: string; category: string; status: string; comment: string;
      trace_id: string; created_at: string }>(`SELECT f.id, f.category, f.status, f.comment,
      r.trace_id, f.created_at FROM hz_p5_feedback f
      JOIN hz_p5_answer_receipts r ON r.tenant_id=f.tenant_id AND r.id=f.receipt_id
      WHERE f.tenant_id=$1 AND f.knowledge_base_id=$2
      ORDER BY f.created_at DESC LIMIT 100`, [actor.tenantId, knowledgeBaseId]),
    database.query<{ id: string; status: string; case_count: number;
      config_fingerprint: string; approved_by: string | null; created_at: string }>(`
      SELECT id, status, case_count, config_fingerprint, approved_by, created_at
      FROM hz_p5_eval_runs WHERE tenant_id=$1 AND knowledge_base_id=$2
      ORDER BY created_at DESC LIMIT 100`, [actor.tenantId, knowledgeBaseId]),
  ])
  return { knowledgeBaseId, datasetRevision: Number(state.rows[0]?.revision ?? 0),
    feedback: feedback.rows.map((row) => ({ id: row.id, category: row.category,
      status: row.status, comment: row.comment, traceId: row.trace_id,
      createdAt: new Date(row.created_at).toISOString() })),
    runs: runs.rows.map((row) => ({ id: row.id, status: row.status,
      caseCount: Number(row.case_count), configFingerprint: row.config_fingerprint,
      approvedBy: row.approved_by, createdAt: new Date(row.created_at).toISOString() })) }
}

export function renderFeedbackWorkbench(data: FeedbackWorkbenchData): string {
  const feedbackRows = data.feedback.map((item) => `<tr><td>${escapeHtml(item.id)}</td>
    <td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.status)}</td>
    <td>${escapeHtml(item.comment)}</td><td>${escapeHtml(item.traceId)}</td>
    <td>${escapeHtml(item.createdAt)}</td></tr>`).join('')
  const runRows = data.runs.map((item) => `<tr><td>${escapeHtml(item.id)}</td>
    <td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.caseCount)}</td>
    <td>${escapeHtml(item.configFingerprint)}</td><td>${escapeHtml(item.approvedBy || '待复核')}</td>
    <td>${escapeHtml(item.createdAt)}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>知识反馈与评测台</title><style>
    body{font:15px/1.6 system-ui,sans-serif;background:#f7f9fc;color:#1f2937;margin:0;padding:2rem}
    main{max-width:1280px;margin:auto}section{background:#fff;border:1px solid #dce3ed;border-radius:10px;padding:1.2rem;margin:1rem 0}
    table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid #e5e7eb;text-align:left;padding:.65rem;word-break:break-all}
    th{background:#f1f5f9}.scroll{overflow-x:auto}.notice{color:#465569}
    </style></head><body><main><h1>知识反馈与评测台</h1>
    <p class="notice">知识库 ${escapeHtml(data.knowledgeBaseId)} · 数据集版本 ${escapeHtml(data.datasetRevision)}</p>
    <section><h2>反馈审核</h2><p class="notice">修正建议需人工核对，不能直接改写制度或评测答案。</p>
    <div class="scroll"><table><thead><tr><th>反馈编号</th><th>类别</th><th>状态</th><th>说明</th><th>追踪</th><th>时间</th></tr></thead>
    <tbody>${feedbackRows || '<tr><td colspan="6">暂无反馈</td></tr>'}</tbody></table></div></section>
    <section><h2>回归评测</h2><p class="notice">正式发布须使用当前数据集版本通过评测并经独立复核。</p>
    <div class="scroll"><table><thead><tr><th>运行编号</th><th>结果</th><th>样本数</th><th>配置指纹</th><th>批准人</th><th>时间</th></tr></thead>
    <tbody>${runRows || '<tr><td colspan="6">暂无评测运行</td></tr>'}</tbody></table></div></section>
    </main></body></html>`
}
