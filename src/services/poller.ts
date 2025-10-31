import { PubkyService } from './pubky';
import { EventBus } from '@/core/event-bus';
import { IdempotencyService } from '@/core/idempotency';
import { MetricsService } from '@/services/metrics';
import { MentionReceivedV1 } from '@/core/events';
import { db } from '@/infrastructure/database/connection';
import appConfig from '@/config';
import logger from '@/utils/logger';
import { delay } from '@/utils/time';

export class MentionPoller {
  private isRunning = false;
  private shouldStop = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    private pubkyService: PubkyService,
    private eventBus: EventBus,
    private idempotency: IdempotencyService,
    private metrics: MetricsService
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Mention poller is already running');
      return;
    }

    if (!appConfig.pubky.mentionPolling.enabled) {
      logger.info('Mention polling is disabled in configuration');
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;

    logger.info('Starting mention poller', {
      intervalSeconds: appConfig.pubky.mentionPolling.intervalSeconds,
      batchSize: appConfig.pubky.mentionPolling.batchSize
    });

    // Start the polling loop
    this.pollLoop();
  }

  async stop(): Promise<void> {
    logger.info('Stopping mention poller');

    this.shouldStop = true;

    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }

    // Wait for current polling operation to complete
    while (this.isRunning) {
      await delay(100);
    }

    logger.info('Mention poller stopped');
  }

  private async pollLoop(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      logger.error('Error in polling loop:', error);
      this.metrics.incrementMentions('failed');
    }

    if (!this.shouldStop) {
      // Schedule next poll
      this.pollInterval = setTimeout(
        () => this.pollLoop(),
        appConfig.pubky.mentionPolling.intervalSeconds * 1000
      );
    } else {
      this.isRunning = false;
    }
  }

  private async pollOnce(): Promise<void> {
    logger.debug('Polling for new mentions');

    try {
      // Get last cursor from Pubky service
      const lastCursor = this.pubkyService.getLastCursor();

      // Poll for new mentions
      const mentions = await this.pubkyService.pollMentions(
        lastCursor || undefined,
        appConfig.pubky.mentionPolling.batchSize
      );

      if (mentions.length === 0) {
        logger.debug('No new mentions found');
        return;
      }

      logger.info(`Found ${mentions.length} new mentions`);

      // Process each mention
      for (const mention of mentions) {
        await this.processMention(mention);
      }

      logger.debug(`Processed ${mentions.length} mentions successfully`);

    } catch (error) {
      logger.error('Failed to poll mentions:', error);
      throw error;
    }
  }

  private async processMention(mention: any): Promise<void> {
    const idempotencyKey = `mention:${mention.mentionId}`;

    try {
      const result = await this.idempotency.guard(
        idempotencyKey,
        async () => {
          return this.ingestMention(mention);
        }
      );

      if (!result.executed) {
        logger.debug('Mention already processed', {
          mentionId: mention.mentionId
        });
        return;
      }

      logger.debug('Mention ingested successfully', {
        mentionId: mention.mentionId,
        author: mention.authorId
      });

      this.metrics.incrementMentions('received');

    } catch (error) {
      logger.error('Failed to process mention:', error, {
        mentionId: mention.mentionId
      });

      // Update mention status to failed
      try {
        await this.updateMentionStatus(mention.mentionId, 'failed', error.message);
      } catch (updateError) {
        logger.error('Failed to update mention status:', updateError);
      }

      this.metrics.incrementMentions('failed');
      throw error;
    }
  }

  private async ingestMention(mention: any): Promise<boolean> {
    // Store mention in database
    await this.storeMention(mention);

    // Emit event for processing
    const eventData: MentionReceivedV1 = {
      mentionId: mention.mentionId,
      postId: mention.postId,
      mentionedBy: mention.authorId,
      content: mention.content,
      url: mention.url,
      ts: mention.receivedAt,
      metadata: mention.metadata
    };

    await this.eventBus.emit('mention.received.v1', eventData, {
      correlationId: mention.mentionId,
      key: `mention:${mention.mentionId}`
    });

    logger.info('Mention event emitted', {
      mentionId: mention.mentionId,
      postId: mention.postId
    });

    return true;
  }

  private async storeMention(mention: any): Promise<void> {
    await db.query(
      `INSERT INTO mentions (mention_id, post_id, author_id, content, url, received_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'received')
       ON CONFLICT (mention_id) DO NOTHING`,
      [
        mention.mentionId,
        mention.postId,
        mention.authorId,
        mention.content,
        mention.url,
        mention.receivedAt
      ]
    );

    logger.debug('Mention stored in database', {
      mentionId: mention.mentionId
    });
  }

  private async updateMentionStatus(
    mentionId: string,
    status: string,
    error?: string
  ): Promise<void> {
    await db.query(
      `UPDATE mentions
       SET status = $2, last_error = $3
       WHERE mention_id = $1`,
      [mentionId, status, error]
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.pubkyService.healthCheck();
    } catch (error) {
      logger.error('Poller health check failed:', error);
      return false;
    }
  }

  isPollerRunning(): boolean {
    return this.isRunning;
  }

  getStatus(): {
    running: boolean;
    enabled: boolean;
    intervalSeconds: number;
    batchSize: number;
  } {
    return {
      running: this.isRunning,
      enabled: appConfig.pubky.mentionPolling.enabled,
      intervalSeconds: appConfig.pubky.mentionPolling.intervalSeconds,
      batchSize: appConfig.pubky.mentionPolling.batchSize
    };
  }
}