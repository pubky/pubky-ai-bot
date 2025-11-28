import { PubkyService } from './pubky';
import { EventBus } from '@/core/event-bus';
import { IdempotencyService } from '@/core/idempotency';
import { MetricsService } from '@/services/metrics';
import { MentionReceivedV1 } from '@/core/events';
import { Mention } from '@/types/mention';
import { db } from '@/infrastructure/database/connection';
import appConfig from '@/config';
import logger from '@/utils/logger';
import { delay } from '@/utils/time';

enum CircuitState {
  CLOSED = 'CLOSED',    // Normal operation
  OPEN = 'OPEN',        // Circuit breaker tripped, rejecting requests
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export class MentionPoller {
  private isRunning = false;
  private shouldStop = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastProcessedOffset = 0;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private consecutiveSuccesses = 0;

  // Circuit breaker configuration
  private readonly FAILURE_THRESHOLD = 5;          // Open circuit after 5 failures
  private readonly SUCCESS_THRESHOLD = 2;          // Close circuit after 2 successes in HALF_OPEN
  private readonly OPEN_CIRCUIT_TIMEOUT = 60000;   // Wait 60s before trying HALF_OPEN
  private readonly BASE_BACKOFF_MS = 1000;         // Base backoff: 1 second
  private readonly MAX_BACKOFF_MS = 300000;        // Max backoff: 5 minutes
  private readonly BACKOFF_MULTIPLIER = 2;         // Exponential multiplier

  // Concurrency control
  private readonly MAX_CONCURRENT_MENTIONS = 5;    // Process up to 5 mentions in parallel

  // Age filtering for first pull
  private readonly MAX_NOTIFICATION_AGE_MS = 30 * 60 * 1000; // 30 minutes

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

    // Load last processed offset from database
    await this.loadOffset();

    this.isRunning = true;
    this.shouldStop = false;

    logger.info('Starting mention poller', {
      intervalSeconds: appConfig.pubky.mentionPolling.intervalSeconds,
      batchSize: appConfig.pubky.mentionPolling.batchSize,
      lastProcessedOffset: this.lastProcessedOffset
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
      // Check if circuit breaker allows polling
      if (!this.shouldAttemptPoll()) {
        const backoffMs = this.calculateBackoff();
        logger.debug(`Circuit breaker ${this.circuitState}, backing off for ${backoffMs}ms`);

        if (!this.shouldStop) {
          this.pollInterval = setTimeout(() => this.pollLoop(), backoffMs);
        } else {
          this.isRunning = false;
        }
        return;
      }

      await this.pollOnce();
      this.onSuccess();

    } catch (error) {
      logger.error('Error in polling loop:', error);
      this.metrics.incrementMentions('failed');
      this.onFailure();
    }

    if (!this.shouldStop) {
      // Schedule next poll with backoff if needed
      const nextInterval = this.circuitState === CircuitState.CLOSED
        ? appConfig.pubky.mentionPolling.intervalSeconds * 1000
        : this.calculateBackoff();

      this.pollInterval = setTimeout(() => this.pollLoop(), nextInterval);
    } else {
      this.isRunning = false;
    }
  }

  private async pollOnce(): Promise<void> {
    logger.debug('Polling for new mentions');

    try {
      // We may need to scan through multiple pages within a single poll to
      // quickly skip past duplicate-only pages returned by Nexus.
      // This avoids re-reading the same notifications every poll.
      const limit = appConfig.pubky.mentionPolling.batchSize;
      let pageOffset = this.lastProcessedOffset;
      let pagesScanned = 0;
      let totalAdvanced = 0;
      let processedAny = false;

      // Soft cap to prevent unbounded work in a single poll cycle
      const MAX_PAGES_PER_POLL = 10;

      while (pagesScanned < MAX_PAGES_PER_POLL) {
        // Fetch a page using current offset
        const result = await this.pubkyService.fetchMentionsFromNexus({
          limit,
          offset: pageOffset
        });

        const { mentions, notificationCount } = result;

        // Nothing more to read
        if (notificationCount === 0) {
          break;
        }

        // Pre-filter against mentions already in our DB
        const { newMentions, duplicates } = await this.filterAlreadyProcessedMentions(mentions);

        if (newMentions.length === 0) {
          // Page contained only duplicates; advance locally and keep scanning
          // Suppress duplicate logging - user doesn't care about past duplicates
          pageOffset += notificationCount;
          totalAdvanced += notificationCount;
          pagesScanned++;
          continue;
        }

        // Separate old mentions from recent ones
        const oldMentions: Mention[] = [];
        const recentMentions: Mention[] = [];

        for (const mention of newMentions) {
          if (this.isMentionTooOld(mention)) {
            oldMentions.push(mention);
          } else {
            recentMentions.push(mention);
          }
        }

        // Store old mentions without processing
        if (oldMentions.length > 0) {
          logger.info(`Skipping ${oldMentions.length} old mention(s) (>30 minutes old)`);
          for (const oldMention of oldMentions) {
            try {
              await this.storeOldMention(oldMention);
            } catch (error) {
              logger.error('Failed to store old mention:', error, {
                mentionId: oldMention.mentionId
              });
            }
          }
        }

        // Process new mentions from this page
        if (recentMentions.length > 0) {
          // Only log when we have actual new mentions to process
          logger.info(`Found ${recentMentions.length} new mention(s) to process`);

          // CRITICAL: If ANY mention fails, this throws and we will not persist offset
          await this.processInParallel(recentMentions, this.MAX_CONCURRENT_MENTIONS);
          processedAny = true;
        } else if (oldMentions.length > 0) {
          // All mentions were old, but we still stored them - suppress this log
          logger.debug(`All ${oldMentions.length} mention(s) were too old, stored as skipped`);
        }

        // Advance to next page and continue scanning within this poll
        pageOffset += notificationCount;
        totalAdvanced += notificationCount;
        pagesScanned++;

        // Heuristic: if a page had zero duplicates (all new), it's likely the next page
        // will be older; still continue until we either hit a duplicate-only page or max pages.
      }

      // Persist the furthest offset we safely advanced to in this poll
      if (totalAdvanced > 0) {
        await this.persistOffset(pageOffset);
        this.lastProcessedOffset = pageOffset;
        // Only log offset updates when we actually process mentions
        if (processedAny) {
          logger.debug(`Updated offset to ${this.lastProcessedOffset} (advanced by ${totalAdvanced} notifications)`);
        }
      }

      // We already logged when we found new mentions, no need to log again

    } catch (error) {
      logger.error('Failed to poll mentions:', error);
      throw error;
    }
  }

  /**
   * Process mentions in parallel with concurrency limit
   *
   * CRITICAL: If ANY mention fails, this method throws an error to prevent
   * offset advancement. Idempotency protection ensures successful mentions
   * won't be duplicated on retry.
   */
  private async processInParallel(mentions: Mention[], concurrency: number): Promise<void> {
    const failures: Array<{ mention: Mention; error: Error }> = [];

    for (let i = 0; i < mentions.length; i += concurrency) {
      const batch = mentions.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map(mention => this.processMention(mention))
      );

      // Track failures with context
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'rejected') {
          const mention = batch[j];
          const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));

          failures.push({ mention, error });

          logger.error('Mention processing failed', {
            mentionId: mention.mentionId,
            postId: mention.postId,
            error: error.message
          });
        }
      }
    }

    // CRITICAL: If ANY mention failed, throw error to prevent offset advancement
    // This ensures failed mentions will be retried on next poll
    // Idempotency protection prevents duplicate processing of successful mentions
    if (failures.length > 0) {
      const errorMessage = `${failures.length}/${mentions.length} mentions failed to process. Blocking offset advancement to retry on next poll.`;
      logger.error(errorMessage, {
        failedMentionIds: failures.map(f => f.mention.mentionId)
      });
      throw new Error(errorMessage);
    }
  }

  /**
   * Load last processed offset from database
   */
  private async loadOffset(): Promise<void> {
    try {
      const rows = await db.query<{ last_offset: number }>(
        `SELECT last_offset FROM polling_state WHERE poller_id = $1`,
        ['nexus_mention_poller']
      );

      if (rows.length > 0) {
        this.lastProcessedOffset = rows[0].last_offset;
        logger.info(`Loaded offset from database: ${this.lastProcessedOffset}`);
      } else {
        logger.info('No offset found in database, starting from 0');
        this.lastProcessedOffset = 0;
      }
    } catch (error) {
      logger.error('Failed to load offset from database:', error);
      logger.warn('Starting from offset 0');
      this.lastProcessedOffset = 0;
    }
  }

  /**
   * Persist offset to database transactionally
   */
  private async persistOffset(newOffset: number): Promise<void> {
    try {
      await db.query(
        `UPDATE polling_state
         SET last_offset = $2,
             last_poll_at = now(),
             updated_at = now()
         WHERE poller_id = $1`,
        ['nexus_mention_poller', newOffset]
      );

      logger.debug(`Persisted offset to database: ${newOffset}`);
    } catch (error) {
      logger.error('Failed to persist offset to database:', error);
      throw error;
    }
  }

  /**
   * Circuit breaker: Check if we should attempt polling
   */
  private shouldAttemptPoll(): boolean {
    const now = Date.now();

    switch (this.circuitState) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if enough time has passed to try HALF_OPEN
        if (this.lastFailureTime && (now - this.lastFailureTime) >= this.OPEN_CIRCUIT_TIMEOUT) {
          logger.info('Circuit breaker transitioning from OPEN to HALF_OPEN');
          this.circuitState = CircuitState.HALF_OPEN;
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return false;
    }
  }

  /**
   * Calculate exponential backoff with jitter
   */
  private calculateBackoff(): number {
    if (this.circuitState === CircuitState.CLOSED) {
      return appConfig.pubky.mentionPolling.intervalSeconds * 1000;
    }

    // Exponential backoff: baseDelay * (multiplier ^ failureCount)
    const exponentialDelay = Math.min(
      this.BASE_BACKOFF_MS * Math.pow(this.BACKOFF_MULTIPLIER, this.failureCount),
      this.MAX_BACKOFF_MS
    );

    // Add jitter (±25% randomness)
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Handle successful poll
   */
  private onSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;

      if (this.consecutiveSuccesses >= this.SUCCESS_THRESHOLD) {
        logger.info('Circuit breaker transitioning from HALF_OPEN to CLOSED');
        this.circuitState = CircuitState.CLOSED;
        this.failureCount = 0;
        this.consecutiveSuccesses = 0;
        this.lastFailureTime = null;
      }
    } else if (this.circuitState === CircuitState.CLOSED) {
      // Reset failure count on success
      this.failureCount = 0;
      this.lastFailureTime = null;
    }
  }

  /**
   * Handle failed poll
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.consecutiveSuccesses = 0;

    if (this.circuitState === CircuitState.CLOSED && this.failureCount >= this.FAILURE_THRESHOLD) {
      logger.warn(`Circuit breaker opening after ${this.failureCount} failures`);
      this.circuitState = CircuitState.OPEN;
    } else if (this.circuitState === CircuitState.HALF_OPEN) {
      logger.warn('Circuit breaker reopening after failure in HALF_OPEN state');
      this.circuitState = CircuitState.OPEN;
    }

    logger.debug('Circuit breaker state', {
      state: this.circuitState,
      failureCount: this.failureCount,
      consecutiveSuccesses: this.consecutiveSuccesses
    });
  }

  private async processMention(mention: Mention): Promise<void> {
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to process mention:', error, {
        mentionId: mention.mentionId
      });

      // Update mention status to failed
      try {
        await this.updateMentionStatus(mention.mentionId, 'failed', errorMessage);
      } catch (updateError) {
        logger.error('Failed to update mention status:', updateError);
      }

      this.metrics.incrementMentions('failed');
      throw error;
    }
  }

  private async ingestMention(mention: Mention): Promise<boolean> {
    // Check if the post is already marked as deleted
    let isDeleted = false;
    try {
      const deletedCheck = await db.query(
        'SELECT id FROM deleted_posts WHERE post_uri = $1',
        [mention.postId]
      );

      // Check if result exists and has any rows
      isDeleted = deletedCheck && deletedCheck.length > 0;
    } catch (error) {
      // If the table doesn't exist or query fails, assume not deleted
      logger.debug('Failed to check deleted posts table (table may not exist yet):', error);
      isDeleted = false;
    }

    if (isDeleted) {
      logger.info('Skipping mention for already-deleted post', {
        mentionId: mention.mentionId,
        postId: mention.postId
      });

      // Store the mention but mark it as failed due to deleted post
      // IMPORTANT: Don't catch this error - let it bubble up so the mention can be retried
      await db.query(
        `INSERT INTO mentions (mention_id, post_id, author_id, content, url, received_at, status, error_type, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed', 'post_deleted', 'Post already marked as deleted')
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

      return false; // Don't emit event for deleted posts
    }

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

  private async storeMention(mention: Mention): Promise<void> {
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

  /**
   * Store old mention in database without processing
   * Used to mark notifications as seen so they won't be processed on restart
   */
  private async storeOldMention(mention: Mention): Promise<void> {
    await db.query(
      `INSERT INTO mentions (mention_id, post_id, author_id, content, url, received_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'skipped_old')
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

    logger.debug('Old mention stored in database as skipped', {
      mentionId: mention.mentionId,
      age: Date.now() - new Date(mention.receivedAt).getTime()
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

  /**
   * Check if a mention is too old to process (older than MAX_NOTIFICATION_AGE_MS)
   * Used to skip old notifications on first pull to avoid processing backlog
   */
  private isMentionTooOld(mention: Mention): boolean {
    const receivedAt = new Date(mention.receivedAt).getTime();
    const now = Date.now();
    const age = now - receivedAt;
    return age > this.MAX_NOTIFICATION_AGE_MS;
  }

  /**
   * Filter out mentions that are already persisted in the database.
   * This prevents reprocessing the same mentions across polling cycles
   * when the upstream API returns overlapping pages or ignores offset.
   */
  private async filterAlreadyProcessedMentions(mentions: Mention[]): Promise<{ newMentions: Mention[]; duplicates: number }> {
    if (mentions.length === 0) {
      return { newMentions: [], duplicates: 0 };
    }

    try {
      const ids = mentions.map(m => m.mentionId);
      const postIds = mentions.map(m => m.postId);
      const rows = await db.query<{ mention_id: string; post_id: string }>(
        `SELECT mention_id, post_id
         FROM mentions
         WHERE mention_id = ANY($1::text[])
            OR post_id = ANY($2::text[])`,
        [ids, postIds]
      );

      const existingByMentionId = new Set(rows.map(r => r.mention_id));
      const existingByPostId = new Set(rows.map(r => r.post_id));
      const newMentions = mentions.filter(m => !existingByMentionId.has(m.mentionId) && !existingByPostId.has(m.postId));
      const duplicates = mentions.length - newMentions.length;

      // Suppress duplicate logging - user doesn't care about past duplicates
      // Only log if there are NEW mentions
      if (newMentions.length > 0 && duplicates > 0) {
        logger.debug(`Processing ${newMentions.length} new mention(s) (${duplicates} duplicate(s) filtered)`);
      }

      return { newMentions, duplicates };
    } catch (error) {
      logger.warn('Failed to check existing mentions; proceeding without pre-filter', error);
      return { newMentions: mentions, duplicates: 0 };
    }
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
    circuitBreaker: {
      state: string;
      failureCount: number;
      consecutiveSuccesses: number;
    };
  } {
    return {
      running: this.isRunning,
      enabled: appConfig.pubky.mentionPolling.enabled,
      intervalSeconds: appConfig.pubky.mentionPolling.intervalSeconds,
      batchSize: appConfig.pubky.mentionPolling.batchSize,
      circuitBreaker: {
        state: this.circuitState,
        failureCount: this.failureCount,
        consecutiveSuccesses: this.consecutiveSuccesses
      }
    };
  }
}
