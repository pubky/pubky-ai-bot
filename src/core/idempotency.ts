import { redis } from '@/infrastructure/redis/connection';
import logger from '@/utils/logger';

export interface IdempotencyResult<T> {
  executed: boolean;
  result?: T;
}

export class IdempotencyService {
  private readonly TTL_SECONDS = 86400; // 24 hours
  private readonly KEY_PREFIX = 'idempotent';

  async guard<T>(
    key: string,
    operation: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<IdempotencyResult<T>> {
    const fullKey = `${this.KEY_PREFIX}:${key}`;
    const ttl = ttlSeconds || this.TTL_SECONDS;

    try {
      // Try to set the key if it doesn't exist
      const client = redis.getClient();
      const wasSet = await client.set(fullKey, 'processing', {
        NX: true, // Only set if key doesn't exist
        EX: ttl
      });

      if (!wasSet) {
        // Key already exists - operation was already executed or in progress
        const existingValue = await client.get(fullKey);

        if (existingValue === 'processing') {
          logger.debug(`Operation with key ${key} is already in progress`);
          return { executed: false };
        }

        try {
          const result = JSON.parse(existingValue || '{}');
          logger.debug(`Operation with key ${key} already completed, returning cached result`);
          return { executed: false, result };
        } catch {
          logger.warn(`Invalid cached result for key ${key}, re-executing`);
        }
      }

      // Execute the operation
      logger.debug(`Executing operation with idempotency key ${key}`);
      const result = await operation();

      // Store the result
      await client.set(fullKey, JSON.stringify(result), { EX: ttl });

      return { executed: true, result };

    } catch (error) {
      // Clean up the processing lock on error
      try {
        await redis.getClient().del(fullKey);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup idempotency key ${key}:`, cleanupError);
      }

      logger.error(`Error in idempotent operation ${key}:`, error);
      throw error;
    }
  }

  async isProcessed(key: string): Promise<boolean> {
    const fullKey = `${this.KEY_PREFIX}:${key}`;
    const exists = await redis.getClient().exists(fullKey);
    return exists === 1;
  }

  async getResult<T>(key: string): Promise<T | null> {
    const fullKey = `${this.KEY_PREFIX}:${key}`;
    const value = await redis.getClient().get(fullKey);

    if (!value || value === 'processing') {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  async clear(key: string): Promise<void> {
    const fullKey = `${this.KEY_PREFIX}:${key}`;
    await redis.getClient().del(fullKey);
    logger.debug(`Cleared idempotency key ${key}`);
  }
}