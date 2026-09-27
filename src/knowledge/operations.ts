import { randomUUID } from 'node:crypto'
import { KnowledgeError, verifyKnowledgeActor, type KnowledgeIdentityVerifier,
  type SqlDatabase, type UntrustedKnowledgeContext } from './foundation.js'

export type MetricStage = 'ocr' | 'embedding' | 'chunking' | 'indexing' | 'retrieval' |
  'rerank' | 'generation' | 'answer' | 'queue'
export type MetricOutcome = 'ok' | 'error' | 'timeout' | 'rate_limited' | 'degraded'
const stages: MetricStage[] = ['ocr', 'embedding', 'chunking', 'indexing', 'retrieval',
  'rerank', 'generation', 'answer', 'queue']
const outcomes: MetricOutcome[] = ['ok', 'error', 'timeout', 'rate_limited', 'degraded']
const nonempty = (value: string, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new KnowledgeError('INVALID_INPUT', `${name} 无效`)
  }
  return value.trim()
}
const nonnegative = (value: number) => Number.isSafeInteger(value) && value >= 0

export function classifyProviderFailure(error: { status?: number; code?: string }): {
  kind: 'rate_limited' | 'temporary' | 'timeout' | 'authentication' | 'invalid_request' | 'unknown';
  retryable: boolean } {
  if (error?.status === 429) return { kind: 'rate_limited', retryable: true }
  if (error?.status !== undefined && error.status >= 500 && error.status <= 599) {
    return { kind: 'temporary', retryable: true }
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code ?? '')) {
    return { kind: 'timeout', retryable: true }
  }
  if (error?.status === 401 || error?.status === 403) {
    return { kind: 'authentication', retryable: false }
  }
  if (error?.status !== undefined && error.status >= 400 && error.status <= 499) {
    return { kind: 'invalid_request', retryable: false }
  }
  return { kind: 'unknown', retryable: false }
}

export interface OperationalSnapshot { requests: number; errors: number; rateLimited: number;
  errorRate: number; p95DurationMs: number; costMicros: number; tokenCount: number;
  outboxPending: number; truncated: boolean }
export interface AlertThresholds { maxErrorRate: number; maxP95Ms: number; maxCostMicros: number;
  maxOutboxPending?: number }

export class KnowledgeOperations {
  constructor(private readonly database: SqlDatabase, private readonly identity: KnowledgeIdentityVerifier,
    private readonly now: () => Date = () => new Date()) {}

  async record(context: UntrustedKnowledgeContext, input: { knowledgeBaseId: string;
    traceId: string; stage: MetricStage; outcome: MetricOutcome; durationMs: number;
    tokenCount: number; costMicros: number; httpStatus: number | null }): Promise<void> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'outbox')
    const kb = nonempty(input.knowledgeBaseId, 'knowledgeBaseId', 36)
    const trace = nonempty(input.traceId, 'traceId', 128)
    if (!stages.includes(input.stage) || !outcomes.includes(input.outcome) ||
      !nonnegative(input.durationMs) || !nonnegative(input.tokenCount) ||
      !nonnegative(input.costMicros) || input.httpStatus !== null &&
      (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
      throw new KnowledgeError('INVALID_INPUT', '运行指标无效')
    }
    await this.database.query(`INSERT INTO hz_p5_metrics
      (id, tenant_id, knowledge_base_id, trace_id, stage, outcome,
       duration_ms, token_count, cost_micros, http_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), actor.tenantId, kb, trace, input.stage, input.outcome,
      input.durationMs, input.tokenCount, input.costMicros, input.httpStatus])
  }

  async snapshot(context: UntrustedKnowledgeContext, knowledgeBaseId: string,
    windowMinutes: number): Promise<OperationalSnapshot> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'audit_read')
    const kb = nonempty(knowledgeBaseId, 'knowledgeBaseId', 36)
    if (!Number.isSafeInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
      throw new KnowledgeError('INVALID_INPUT', '监测时间窗无效')
    }
    const since = new Date(this.now().getTime() - windowMinutes * 60000).toISOString()
    const rows = (await this.database.query<{ outcome: MetricOutcome; duration_ms: number;
      token_count: number; cost_micros: number }>(`SELECT outcome, duration_ms, token_count,
      cost_micros FROM hz_p5_metrics WHERE tenant_id=$1 AND knowledge_base_id=$2
      AND created_at >= $3 ORDER BY created_at DESC LIMIT 10001`,
    [actor.tenantId, kb, since])).rows
    const truncated = rows.length > 10000
    const sample = rows.slice(0, 10000)
    const durations = sample.map((row) => Number(row.duration_ms)).sort((a, b) => a - b)
    const errors = sample.filter((row) => row.outcome !== 'ok').length
    const pending = (await this.database.query<{ count: number }>(`SELECT count(*)::integer AS count
      FROM hz_outbox WHERE tenant_id=$1 AND delivered_at IS NULL`, [actor.tenantId])).rows[0]
    return { requests: sample.length, errors, rateLimited: sample.filter((row) =>
      row.outcome === 'rate_limited').length, errorRate: sample.length ? errors / sample.length : 0,
    p95DurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : 0,
    costMicros: sample.reduce((sum, row) => sum + Number(row.cost_micros), 0),
    tokenCount: sample.reduce((sum, row) => sum + Number(row.token_count), 0),
    outboxPending: Number(pending?.count ?? 0), truncated }
  }

  alerts(snapshot: OperationalSnapshot, thresholds: AlertThresholds): string[] {
    if ([thresholds.maxErrorRate, thresholds.maxP95Ms, thresholds.maxCostMicros].some((value) =>
      !Number.isFinite(value) || value < 0)) throw new KnowledgeError('INVALID_INPUT', '告警阈值无效')
    const alerts: string[] = []
    if (snapshot.truncated) alerts.push('metrics_truncated')
    if (snapshot.requests && snapshot.errorRate > thresholds.maxErrorRate) alerts.push('error_rate_high')
    if (snapshot.requests && snapshot.p95DurationMs > thresholds.maxP95Ms) alerts.push('latency_p95_high')
    if (snapshot.costMicros > thresholds.maxCostMicros) alerts.push('cost_budget_exceeded')
    if (thresholds.maxOutboxPending !== undefined && snapshot.outboxPending > thresholds.maxOutboxPending) {
      alerts.push('outbox_backlog_high')
    }
    return alerts
  }

  async readAudit(context: UntrustedKnowledgeContext, resourceType: string, resourceId: string,
    limit: number): Promise<Array<{ action: string; actorId: string; result: string;
      reason: string | null; traceId: string | null; createdAt: string }>> {
    const actor = await verifyKnowledgeActor(context, this.identity, 'audit_read')
    const type = nonempty(resourceType, 'resourceType', 32)
    const id = nonempty(resourceId, 'resourceId', 36)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KnowledgeError('INVALID_INPUT', '审计查询条数无效')
    }
    const rows = (await this.database.query<{ action: string; actor_id: string; result: string;
      reason: string | null; trace_id: string | null; created_at: string }>(`
      SELECT action, actor_id, result, reason, trace_id, created_at FROM hz_audit_events
      WHERE tenant_id=$1 AND resource_type=$2 AND resource_id=$3
      ORDER BY created_at DESC LIMIT $4`, [actor.tenantId, type, id, limit])).rows
    return rows.map((row) => ({ action: row.action, actorId: row.actor_id, result: row.result,
      reason: row.reason, traceId: row.trace_id,
      createdAt: new Date(row.created_at).toISOString() }))
  }
}
