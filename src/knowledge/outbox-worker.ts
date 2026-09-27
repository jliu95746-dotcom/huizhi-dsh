import { KnowledgeError, type KnowledgeFoundation,
  type UntrustedKnowledgeContext } from './foundation.js'
import { classifyProviderFailure } from './operations.js'

type OutboxEvent = Awaited<ReturnType<KnowledgeFoundation['leaseOutbox']>>[number]
export type OutboxHandler = (event: Pick<OutboxEvent, 'eventId' | 'topic' | 'aggregateId' | 'payload'>) => Promise<void>

export class KnowledgeOutboxWorker {
  constructor(private readonly foundation: Pick<KnowledgeFoundation,
    'leaseOutbox' | 'ackOutbox' | 'failOutbox'>, private readonly handler: OutboxHandler) {}

  async runOnce(context: UntrustedKnowledgeContext, limit = 20): Promise<{
    leased: number; delivered: number; retrying: number; manualReview: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KnowledgeError('INVALID_INPUT', '事件批次大小无效')
    }
    const events = await this.foundation.leaseOutbox(context, { limit, leaseSeconds: 30 })
    const summary = { leased: events.length, delivered: 0, retrying: 0, manualReview: 0 }
    for (const event of events) {
      try {
        await this.handler({ eventId: event.eventId, topic: event.topic,
          aggregateId: event.aggregateId, payload: event.payload })
        await this.foundation.ackOutbox(context, { eventId: event.eventId, leaseToken: event.leaseToken })
        summary.delivered++
      } catch (error) {
        const classified = classifyProviderFailure(error && typeof error === 'object' ? error : {})
        await this.foundation.failOutbox(context, { eventId: event.eventId,
          leaseToken: event.leaseToken,
          retryAfterSeconds: classified.retryable ? Math.min(3600, 2 ** Math.min(event.attempts, 10)) : 86400 })
        if (classified.retryable) summary.retrying++
        else summary.manualReview++
      }
    }
    return summary
  }
}
