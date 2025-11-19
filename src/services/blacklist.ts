import { RedisClientType } from 'redis';
import logger from '@/utils/logger';

export interface BlacklistResult {
  allowed: boolean;
  isBlacklisted: boolean;
  reason?: string;
}

/**
 * Blacklist service using Redis SET for public key blocking.
 *
 * Maintains a list of blocked public keys that should not receive bot responses.
 * Uses Redis SET for O(1) membership checks.
 *
 * Algorithm:
 * 1. Initialize Redis SET with configured public keys
 * 2. Check membership for incoming requests
 * 3. Block requests from blacklisted keys
 */
export class BlacklistService {
  private readonly keyPrefix = 'blacklist:pubkey';

  constructor(
    private redis: RedisClientType,
    private initialBlacklist: string[] = []
  ) {
    logger.info('BlacklistService initialized', {
      blacklistedCount: this.initialBlacklist.length
    });

    // Initialize blacklist in Redis
    this.initializeBlacklist().catch(error => {
      logger.error('Failed to initialize blacklist in Redis:', error);
    });
  }

  /**
   * Initialize Redis SET with configured blacklist
   */
  private async initializeBlacklist(): Promise<void> {
    if (this.initialBlacklist.length === 0) {
      logger.debug('No public keys in initial blacklist');
      return;
    }

    try {
      // Add all initial blacklist entries to Redis SET
      await this.redis.sAdd(this.keyPrefix, this.initialBlacklist);

      logger.info('Blacklist initialized in Redis', {
        count: this.initialBlacklist.length
      });
    } catch (error) {
      logger.error('Failed to add initial blacklist to Redis:', error);
      throw error;
    }
  }

  /**
   * Check if a public key is blacklisted
   */
  async checkBlacklist(publicKey: string): Promise<BlacklistResult> {
    try {
      const isBlacklisted = await this.redis.sIsMember(this.keyPrefix, publicKey);

      if (isBlacklisted) {
        logger.debug('Public key is blacklisted', { publicKey });
      }

      return {
        allowed: !isBlacklisted,
        isBlacklisted,
        reason: isBlacklisted ? 'Public key is blacklisted' : undefined
      };
    } catch (error) {
      logger.error('Blacklist check failed:', error, { publicKey });

      // Fail open: allow request on Redis errors to prevent service disruption
      logger.warn('Blacklist check failed - allowing request (fail open)', {
        publicKey,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        allowed: true,
        isBlacklisted: false
      };
    }
  }

  /**
   * Add a public key to the blacklist
   */
  async addToBlacklist(publicKey: string): Promise<void> {
    try {
      await this.redis.sAdd(this.keyPrefix, publicKey);
      logger.info('Added public key to blacklist', { publicKey });
    } catch (error) {
      logger.error('Failed to add public key to blacklist:', error, { publicKey });
      throw error;
    }
  }

  /**
   * Remove a public key from the blacklist
   */
  async removeFromBlacklist(publicKey: string): Promise<void> {
    try {
      await this.redis.sRem(this.keyPrefix, publicKey);
      logger.info('Removed public key from blacklist', { publicKey });
    } catch (error) {
      logger.error('Failed to remove public key from blacklist:', error, { publicKey });
      throw error;
    }
  }

  /**
   * Get all blacklisted public keys
   */
  async getBlacklist(): Promise<string[]> {
    try {
      const members = await this.redis.sMembers(this.keyPrefix);
      return members;
    } catch (error) {
      logger.error('Failed to get blacklist:', error);
      throw error;
    }
  }

  /**
   * Clear the entire blacklist
   */
  async clearBlacklist(): Promise<void> {
    try {
      await this.redis.del(this.keyPrefix);
      logger.info('Blacklist cleared');
    } catch (error) {
      logger.error('Failed to clear blacklist:', error);
      throw error;
    }
  }

  /**
   * Health check - verify Redis connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple check: try to get blacklist count
      await this.redis.sCard(this.keyPrefix);
      return true;
    } catch (error) {
      logger.error('Blacklist service health check failed:', error);
      return false;
    }
  }
}
