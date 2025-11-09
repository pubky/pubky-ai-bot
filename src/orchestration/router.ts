import { EventBus } from '@/core/event-bus';
import { MentionReceivedV1, ActionRequestedV1 } from '@/core/events';
import { ClassifierService } from '@/services/classifier';
import { IdempotencyService } from '@/core/idempotency';
import { MetricsService } from '@/services/metrics';
import { db } from '@/infrastructure/database/connection';
import { RoutingDecision } from './types';
import appConfig from '@/config';
import logger from '@/utils/logger';

export class Router {
  constructor(
    private eventBus: EventBus,
    private classifier: ClassifierService,
    private idempotency: IdempotencyService,
    private metrics: MetricsService
  ) {}

  async start(): Promise<void> {
    await this.eventBus.subscribe(
      'mention.received.v1',
      'router',
      'router-001',
      this.handleMentionReceived.bind(this)
    );

    logger.info('Router started and listening for mentions');
  }

  private async handleMentionReceived(event: any): Promise<void> {
    const data = event.data as MentionReceivedV1;
    const runId = `route_${event.id}`;

    logger.debug('Processing mention for routing', {
      mentionId: data.mentionId,
      runId,
      eventId: event.id
    });

    const idempotencyKey = `route:${data.mentionId}`;

    try {
      const result = await this.idempotency.guard(
        idempotencyKey,
        async () => {
          return this.processMentionRouting(data, runId);
        }
      );

      if (!result.executed) {
        logger.debug('Mention routing already processed', {
          mentionId: data.mentionId,
          runId
        });
        return;
      }

      logger.debug('Mention routing completed', {
        mentionId: data.mentionId,
        runId,
        decision: result.result
      });

    } catch (error) {
      logger.error('Failed to route mention:', error, {
        mentionId: data.mentionId,
        runId
      });

      this.metrics.incrementActions('routing', 'failed');
      throw error;
    }
  }

  private async processMentionRouting(
    data: MentionReceivedV1,
    runId: string
  ): Promise<RoutingDecision> {
    this.metrics.incrementActions('routing', 'started');

    // Build mention object for classification
    const mention = {
      mentionId: data.mentionId,
      postId: data.postId,
      authorId: data.mentionedBy,
      content: data.content,
      url: data.url,
      receivedAt: data.ts,
      status: 'processing' as const
    };

    // Classify intent
    const decision = await this.classifier.routeMention(mention);

    // Store routing decision for audit
    await this.storeRoutingDecision(data.mentionId, decision);

    // Route to appropriate action if intent is known
    if (decision.intent !== 'unknown') {
      await this.emitActionEvent(data, decision.intent, runId);
      this.metrics.incrementActions('routing', 'completed');
    } else {
      logger.debug('Unknown intent, no action taken', {
        mentionId: data.mentionId,
        decision
      });

      // Check if we should default to summary for unknown intents
      if (appConfig.features.summary && this.shouldDefaultToSummary(decision)) {
        logger.debug('Defaulting unknown intent to summary', {
          mentionId: data.mentionId
        });

        await this.emitActionEvent(data, 'summary', runId);
        decision.intent = 'summary';
        decision.reason = `${decision.reason} (defaulted to summary)`;
      }

      this.metrics.incrementActions('routing', 'completed');
    }

    return decision;
  }

  private async storeRoutingDecision(
    mentionId: string,
    decision: RoutingDecision
  ): Promise<void> {
    try {
      await db.query(
        `INSERT INTO routing_decisions (mention_id, intent, confidence, reason)
         VALUES ($1, $2, $3, $4)`,
        [mentionId, decision.intent, decision.confidence, decision.reason]
      );

      logger.debug('Routing decision stored', {
        mentionId,
        intent: decision.intent,
        confidence: decision.confidence
      });

    } catch (error) {
      logger.error('Failed to store routing decision:', error);
      // Don't throw - this is not critical for routing flow
    }
  }

  private async emitActionEvent(
    data: MentionReceivedV1,
    intent: 'summary' | 'factcheck',
    runId: string
  ): Promise<void> {
    const actionData: ActionRequestedV1 = {
      mentionId: data.mentionId,
      postId: data.postId,
      parentUri: data.url,
      intent
    };

    const eventType = intent === 'summary'
      ? 'action.summary.requested.v1'
      : 'action.factcheck.requested.v1';

    await this.eventBus.emit(eventType, actionData, {
      correlationId: data.mentionId,
      key: `action:${intent}:${data.mentionId}`
    });

    logger.info('Action event emitted', {
      mentionId: data.mentionId,
      intent,
      eventType,
      runId
    });
  }

  private shouldDefaultToSummary(decision: RoutingDecision): boolean {
    // Default to summary if:
    // 1. Feature is enabled
    // 2. Confidence is very low (< 0.3) indicating we really don't know
    // 3. Method was LLM (heuristics didn't match anything)

    return appConfig.features.summary &&
           decision.confidence < 0.3 &&
           decision.method === 'llm';
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Check if we can classify a simple test mention
      const testMention = {
        mentionId: 'health-check',
        postId: 'test',
        authorId: 'system',
        content: 'test classification',
        receivedAt: new Date().toISOString(),
        status: 'received' as const
      };

      await this.classifier.routeMention(testMention);
      return true;

    } catch (error) {
      logger.error('Router health check failed:', error);
      return false;
    }
  }
}