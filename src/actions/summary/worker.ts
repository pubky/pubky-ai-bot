import { EventBus } from '@/core/event-bus';
import { ActionRequestedV1, ActionCompletedV1, ActionFailedV1 } from '@/core/events';
import { IdempotencyService } from '@/core/idempotency';
import { SummaryService } from '@/services/summary';
import { ThreadService } from '@/services/thread';
import { ReplyService } from '@/services/reply';
import { SafetyService } from '@/services/safety';
import { MetricsService } from '@/services/metrics';
import { SummaryTemplates } from './templates';
import { db } from '@/infrastructure/database/connection';
import { generateId, generateRunId } from '@/utils/ids';
import { getCurrentTimestamp } from '@/utils/time';
import logger from '@/utils/logger';

export class SummaryWorker {
  constructor(
    private eventBus: EventBus,
    private idempotency: IdempotencyService,
    private summaryService: SummaryService,
    private threadService: ThreadService,
    private replyService: ReplyService,
    private safetyService: SafetyService,
    private metrics: MetricsService
  ) {}

  async start(): Promise<void> {
    await this.eventBus.subscribe(
      'action.summary.requested.v1',
      'summary-workers',
      'summary-worker-001',
      this.handleSummaryRequest.bind(this)
    );

    logger.info('Summary worker started and listening for requests');
  }

  private async handleSummaryRequest(event: any): Promise<void> {
    const data = event.data as ActionRequestedV1;
    const runId = generateRunId();

    logger.debug('Processing summary request', {
      mentionId: data.mentionId,
      postId: data.postId,
      runId,
      eventId: event.id
    });

    const idempotencyKey = `action:summary:${data.mentionId}`;

    try {
      const result = await this.idempotency.guard(
        idempotencyKey,
        async () => {
          return this.executeSummarization(data, runId);
        }
      );

      if (!result.executed) {
        logger.debug('Summary action already processed', {
          mentionId: data.mentionId,
          runId
        });
        return;
      }

      logger.debug('Summary action completed', {
        mentionId: data.mentionId,
        runId,
        success: result.result?.success
      });

    } catch (error) {
      logger.error('Failed to process summary request:', error);

      await this.emitFailedEvent(data, runId, error);
      this.metrics.incrementActions('summary', 'failed');
      throw error;
    }
  }

  private async executeSummarization(
    data: ActionRequestedV1,
    runId: string
  ): Promise<{ success: boolean; executionId: string }> {
    const startTime = Date.now();
    const endActionTimer = this.metrics.startActionTimer('summary');
    this.metrics.incrementActions('summary', 'started');

    // Create action execution record
    const executionId = await this.createActionExecution(data.mentionId, 'summary');

    try {
      // Build thread context
      logger.debug('Building thread context for summarization', {
        mentionId: data.mentionId,
        postId: data.postId,
        runId
      });

      const threadContext = await this.threadService.buildThreadContext(data.postId);

      // Validate thread
      const validation = this.threadService.validate(threadContext);
      if (!validation.isComplete) {
        logger.warn('Thread validation issues detected', {
          mentionId: data.mentionId,
          issues: validation.issues,
          warnings: validation.warnings
        });
      }

      // Generate summary
      logger.debug('Generating summary', {
        mentionId: data.mentionId,
        postCount: threadContext.posts.length,
        totalTokens: threadContext.totalTokens
      });

      const summaryResult = await this.summaryService.generate(threadContext, {
        maxKeyPoints: 3,
        includeParticipants: true,
        style: 'brief'
      });

      // Format reply
      const replyContent = SummaryTemplates.formatReply(summaryResult);
      const replyText = this.replyService.compose(replyContent);

      // Safety check
      const safetyCheck = this.safetyService.performComprehensiveCheck(replyText);
      if (safetyCheck.blocked) {
        logger.warn('Summary reply blocked by safety check', {
          mentionId: data.mentionId,
          reason: safetyCheck.reason,
          matches: safetyCheck.matches
        });

        throw new Error(`Reply blocked by safety check: ${safetyCheck.reason}`);
      }

      // Publish reply
      let replyRef = null;
      if (data.parentUri) {
        replyRef = await this.replyService.publish(
          data.parentUri,
          replyText,
          data.mentionId
        );

        this.metrics.incrementReplies('summary');
        logger.info('Summary reply published', {
          mentionId: data.mentionId,
          replyId: replyRef.id,
          contentLength: replyText.length
        });
      }

      // Store artifacts
      const artifacts = SummaryTemplates.formatArtifacts(summaryResult);
      await this.storeArtifacts(executionId, artifacts);

      // Complete action execution
      await this.completeActionExecution(executionId, {
        durationMs: Date.now() - startTime,
        tokensUsed: summaryResult.metrics.summaryTokens
      });

      // Emit completion event
      await this.emitCompletedEvent(data, executionId, replyRef, artifacts);

      endActionTimer();
      this.metrics.incrementActions('summary', 'completed');

      return { success: true, executionId };

    } catch (error) {
      // Update execution with error
      await this.failActionExecution(executionId, error);
      endActionTimer();
      throw error;
    }
  }

  private async createActionExecution(mentionId: string, actionId: string): Promise<string> {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO action_executions (mention_id, action_id, status)
       VALUES ($1, $2, 'started')
       RETURNING id`,
      [mentionId, actionId]
    );

    return rows[0].id;
  }

  private async completeActionExecution(
    executionId: string,
    metrics: { durationMs: number; tokensUsed?: number }
  ): Promise<void> {
    await db.query(
      `UPDATE action_executions
       SET status = 'completed', completed_at = now(), metrics_json = $2
       WHERE id = $1`,
      [executionId, JSON.stringify(metrics)]
    );
  }

  private async failActionExecution(executionId: string, error: any): Promise<void> {
    const errorData = {
      message: error instanceof Error ? error.message : 'Unknown error',
      code: error.code || 'SUMMARY_ERROR',
      stack: error instanceof Error ? error.stack : undefined
    };

    await db.query(
      `UPDATE action_executions
       SET status = 'failed', completed_at = now(), error_json = $2
       WHERE id = $1`,
      [executionId, JSON.stringify(errorData)]
    );
  }

  private async storeArtifacts(executionId: string, artifacts: any): Promise<void> {
    await db.query(
      `INSERT INTO artifacts (action_execution_id, type, payload_json)
       VALUES ($1, 'summary', $2)`,
      [executionId, JSON.stringify(artifacts)]
    );
  }

  private async emitCompletedEvent(
    data: ActionRequestedV1,
    executionId: string,
    replyRef: any,
    artifacts: any
  ): Promise<void> {
    const completedData: ActionCompletedV1 = {
      mentionId: data.mentionId,
      actionId: 'summary',
      executionId,
      reply: replyRef ? {
        text: replyRef.content,
        parentUri: replyRef.parentUri,
        replyUri: replyRef.uri
      } : undefined,
      artifacts
    };

    await this.eventBus.emit('action.summary.completed.v1', completedData, {
      correlationId: data.mentionId
    });
  }

  private async emitFailedEvent(
    data: ActionRequestedV1,
    runId: string,
    error: any
  ): Promise<void> {
    const failedData: ActionFailedV1 = {
      mentionId: data.mentionId,
      actionId: 'summary',
      executionId: runId,
      error: {
        code: error.code || 'SUMMARY_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      retryable: true
    };

    await this.eventBus.emit('action.summary.failed.v1', failedData, {
      correlationId: data.mentionId
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Simple check to ensure services are available
      const testContext = {
        rootPost: {
          id: 'test',
          uri: 'test',
          content: 'Test content for health check',
          authorId: 'system',
          createdAt: new Date().toISOString()
        },
        posts: [],
        participants: ['system'],
        participantProfiles: [{
          publicKey: 'system',
          displayName: 'System'
        }],
        depth: 1,
        totalTokens: 10,
        isComplete: true
      };

      await this.summaryService.generate(testContext, { style: 'brief' });
      return true;

    } catch (error) {
      logger.error('Summary worker health check failed:', error);
      return false;
    }
  }
}