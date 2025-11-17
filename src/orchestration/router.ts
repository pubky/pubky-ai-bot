import { EventBus } from '@/core/event-bus';
import { MentionReceivedV1, ActionRequestedV1 } from '@/core/events';
import { ClassifierService } from '@/services/classifier';
import { IdempotencyService } from '@/core/idempotency';
import { MetricsService } from '@/services/metrics';
import { RateLimitService } from '@/services/rate-limit';
import { BlacklistService } from '@/services/blacklist';
import { db } from '@/infrastructure/database/connection';
import { RoutingDecision } from './types';
import appConfig from '@/config';
import logger from '@/utils/logger';

export class Router {
  constructor(
    private eventBus: EventBus,
    private classifier: ClassifierService,
    private idempotency: IdempotencyService,
    private metrics: MetricsService,
    private rateLimit: RateLimitService,
    private blacklist: BlacklistService
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
          // Check blacklist FIRST (fail-fast for blocked users)
          const blacklistResult = await this.blacklist.checkBlacklist(data.mentionedBy);

          if (!blacklistResult.allowed) {
            logger.warn('Mention from blacklisted user - ignoring request', {
              mentionId: data.mentionId,
              publicKey: data.mentionedBy,
              reason: blacklistResult.reason
            });

            this.metrics.incrementActions('routing', 'blacklisted');

            // Return a special result to indicate blacklisting
            return {
              intent: 'blacklisted' as const,
              confidence: 1.0,
              reason: blacklistResult.reason || 'User is blacklisted',
              method: 'blacklist' as const
            };
          }

          // Check rate limit BEFORE processing (prevents costly AI calls)
          const rateLimitResult = await this.rateLimit.checkRateLimit(
            data.mentionedBy,
            data.mentionId
          );

          if (!rateLimitResult.allowed) {
            logger.warn('Mention rate limited - ignoring request', {
              mentionId: data.mentionId,
              publicKey: data.mentionedBy,
              currentCount: rateLimitResult.currentCount,
              limit: rateLimitResult.limit,
              windowMinutes: rateLimitResult.windowMinutes,
              retryAfterSeconds: rateLimitResult.retryAfterSeconds
            });

            this.metrics.incrementActions('routing', 'rate_limited');

            // Return a special result to indicate rate limiting
            return {
              intent: 'rate_limited' as const,
              confidence: 1.0,
              reason: `Rate limit exceeded: ${rateLimitResult.currentCount}/${rateLimitResult.limit} requests in ${rateLimitResult.windowMinutes} minutes`,
              method: 'rate_limit' as const
            };
          }

          // Existing processing logic
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

      // Log blacklisted requests differently
      if (result.result?.intent === 'blacklisted') {
        logger.info('Mention processed but user is blacklisted', {
          mentionId: data.mentionId,
          reason: result.result.reason
        });
        return;
      }

      // Log rate limited requests differently
      if (result.result?.intent === 'rate_limited') {
        logger.info('Mention processed but rate limited', {
          mentionId: data.mentionId,
          reason: result.result.reason
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

      // Conservative fallback: Only default to summary if extremely uncertain
      if (appConfig.features.summary && this.shouldDefaultToSummary(decision)) {
        logger.warn('Defaulting unknown intent to summary (very low confidence)', {
          mentionId: data.mentionId,
          confidence: decision.confidence,
          reason: decision.reason
        });

        await this.emitActionEvent(data, 'summary', runId);
        decision.intent = 'summary';
        decision.reason = `${decision.reason} (defaulted to summary due to extreme uncertainty)`;
      } else {
        logger.info('Intent remains unknown - no action taken', {
          mentionId: data.mentionId,
          confidence: decision.confidence
        });
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
    // Conservative approach: Only default to summary if extremely uncertain
    // Requirements:
    // 1. Feature is enabled
    // 2. Confidence is EXTREMELY low (< 0.15) - LLM is very unsure
    // 3. Method was LLM (heuristics didn't match anything)
    //
    // Philosophy: When uncertain, prefer no action over wrong action
    // Only default when LLM gives almost no confidence

    return appConfig.features.summary &&
           decision.confidence < 0.15 &&
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

      // Check if blacklist service is working
      const blacklistHealthy = await this.blacklist.healthCheck();
      if (!blacklistHealthy) {
        logger.warn('Blacklist service health check failed');
        return false;
      }

      // Check if rate limit service is working
      const rateLimitHealthy = await this.rateLimit.healthCheck();
      if (!rateLimitHealthy) {
        logger.warn('Rate limit service health check failed');
        return false;
      }

      return true;

    } catch (error) {
      logger.error('Router health check failed:', error);
      return false;
    }
  }
}