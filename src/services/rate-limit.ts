import { RedisClientType } from 'redis';
import logger from '@/utils/logger';

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  windowMinutes: number;
  retryAfterSeconds?: number;
}

export interface RateLimitStatus {
  publicKey: string;
  requestCount: number;
  limit: number;
  windowMinutes: number;
  oldestRequestAt?: Date;
  newestRequestAt?: Date;
}

/**
 * Rate limiting service using Redis sorted sets (ZSET) for rolling window implementation.
 *
 * Tracks requests per user (by public key) and enforces configurable rate limits.
 * Uses Redis ZSET with timestamps as scores for efficient rolling window management.
 *
 * Algorithm:
 * 1. Remove expired entries (older than window)
 * 2. Count current requests in window
 * 3. Check if limit exceeded
 * 4. Add new request if allowed
 * 5. Set TTL for automatic cleanup
 */
export class RateLimitService {
  private readonly keyPrefix = 'ratelimit:user';
  private readonly TTL_BUFFER_SECONDS = 60; // Buffer for TTL expiration
  private readonly MINIMUM_RETRY_SECONDS = 1; // Minimum retry-after value
  private readonly MS_PER_MINUTE = 60 * 1000; // Milliseconds in a minute

  constructor(
    private redis: RedisClientType,
    private maxRequests: number,
    private windowMinutes: number
  ) {
    logger.info('RateLimitService initialized', {
      maxRequests: this.maxRequests,
      windowMinutes: this.windowMinutes
    });
  }

  /**
   * Check if a request from a user should be rate limited.
   *
   * Uses Redis ZSET to track request timestamps in a rolling window.
   * Automatically removes expired entries and adds new requests if allowed.
   *
   * @param publicKey - User's public key (author of mention)
   * @param mentionId - Unique mention ID for tracking
   * @returns RateLimitResult indicating if request is allowed
   */
  async checkRateLimit(publicKey: string, mentionId: string): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}:${publicKey}`;
    const now = Date.now();
    const windowStart = now - (this.windowMinutes * this.MS_PER_MINUTE);

    try {
      // 1. Remove expired entries (older than window)
      await this.redis.zRemRangeByScore(key, '-inf', windowStart);

      // 2. Count requests in current window
      const count = await this.redis.zCard(key);

      // 3. Check if limit exceeded
      if (count >= this.maxRequests) {
        // Get oldest request timestamp to calculate retry-after
        const oldest = await this.redis.zRangeWithScores(key, 0, 0);
        const retryAfter = oldest.length > 0
          ? Math.ceil((oldest[0].score + this.windowMinutes * this.MS_PER_MINUTE - now) / 1000)
          : this.windowMinutes * 60;

        logger.debug('Rate limit exceeded', {
          publicKey,
          currentCount: count,
          limit: this.maxRequests,
          retryAfterSeconds: retryAfter
        });

        return {
          allowed: false,
          currentCount: count,
          limit: this.maxRequests,
          windowMinutes: this.windowMinutes,
          retryAfterSeconds: Math.max(this.MINIMUM_RETRY_SECONDS, retryAfter)
        };
      }

      // 4. Add current request
      await this.redis.zAdd(key, { score: now, value: mentionId });

      // 5. Set TTL (window + buffer for cleanup)
      const ttlSeconds = this.windowMinutes * 60 + this.TTL_BUFFER_SECONDS;
      await this.redis.expire(key, ttlSeconds);

      logger.debug('Rate limit check passed', {
        publicKey,
        currentCount: count + 1,
        limit: this.maxRequests,
        windowMinutes: this.windowMinutes
      });

      return {
        allowed: true,
        currentCount: count + 1,
        limit: this.maxRequests,
        windowMinutes: this.windowMinutes
      };

    } catch (error) {
      logger.error('Rate limit check failed:', error, {
        publicKey,
        mentionId
      });

      // Fail open: allow request on Redis errors to prevent service disruption
      // Alternative: Fail closed by returning { allowed: false, ... }
      logger.warn('Rate limit check failed - allowing request (fail open)', {
        publicKey,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        allowed: true,
        currentCount: 0,
        limit: this.maxRequests,
        windowMinutes: this.windowMinutes
      };
    }
  }

  /**
   * Get current rate limit status for a user.
   *
   * @param publicKey - User's public key
   * @returns RateLimitStatus with current request count and timing info
   */
  async getRateLimitStatus(publicKey: string): Promise<RateLimitStatus> {
    const key = `${this.keyPrefix}:${publicKey}`;
    const now = Date.now();
    const windowStart = now - (this.windowMinutes * this.MS_PER_MINUTE);

    try {
      // Remove expired entries
      await this.redis.zRemRangeByScore(key, '-inf', windowStart);

      // Get all requests in current window
      const requests = await this.redis.zRangeWithScores(key, 0, -1);

      const status: RateLimitStatus = {
        publicKey,
        requestCount: requests.length,
        limit: this.maxRequests,
        windowMinutes: this.windowMinutes
      };

      if (requests.length > 0) {
        status.oldestRequestAt = new Date(requests[0].score);
        status.newestRequestAt = new Date(requests[requests.length - 1].score);
      }

      return status;

    } catch (error) {
      logger.error('Failed to get rate limit status:', error, { publicKey });

      return {
        publicKey,
        requestCount: 0,
        limit: this.maxRequests,
        windowMinutes: this.windowMinutes
      };
    }
  }

  /**
   * Clear rate limit for a user (admin/testing use).
   *
   * @param publicKey - User's public key
   */
  async clearRateLimit(publicKey: string): Promise<void> {
    const key = `${this.keyPrefix}:${publicKey}`;

    try {
      await this.redis.del(key);
      logger.info('Rate limit cleared', { publicKey });
    } catch (error) {
      logger.error('Failed to clear rate limit:', error, { publicKey });
      throw error;
    }
  }

  /**
   * Health check for rate limit service.
   *
   * @returns true if service is operational
   */
  async healthCheck(): Promise<boolean> {
    try {
      const testKey = 'health-check-test-user';
      const result = await this.checkRateLimit(testKey, 'health-check-test');
      await this.clearRateLimit(testKey);
      return result.allowed;
    } catch (error) {
      logger.error('Rate limit health check failed:', error);
      return false;
    }
  }
}
