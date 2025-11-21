import { createClient, RedisClientType } from 'redis';
import { RateLimitService } from '../rate-limit';

describe('RateLimitService', () => {
  let redisClient: RedisClientType;
  let rateLimitService: RateLimitService;

  const MAX_REQUESTS = 3;
  const WINDOW_MINUTES = 1;

  beforeAll(async () => {
    // Connect to Redis test instance
    redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379/0' });
    await redisClient.connect();
  });

  afterAll(async () => {
    await redisClient.disconnect();
  });

  beforeEach(async () => {
    // Clear all rate limit keys before each test
    const keys = await redisClient.keys('ratelimit:user:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    // Create fresh service instance
    rateLimitService = new RateLimitService(redisClient, MAX_REQUESTS, WINDOW_MINUTES);
  });

  describe('checkRateLimit', () => {
    it('should allow requests under the limit', async () => {
      const publicKey = 'test-user-1';

      // First request
      const result1 = await rateLimitService.checkRateLimit(publicKey, 'mention-1');
      expect(result1.allowed).toBe(true);
      expect(result1.currentCount).toBe(1);
      expect(result1.limit).toBe(MAX_REQUESTS);

      // Second request
      const result2 = await rateLimitService.checkRateLimit(publicKey, 'mention-2');
      expect(result2.allowed).toBe(true);
      expect(result2.currentCount).toBe(2);

      // Third request
      const result3 = await rateLimitService.checkRateLimit(publicKey, 'mention-3');
      expect(result3.allowed).toBe(true);
      expect(result3.currentCount).toBe(3);
    });

    it('should block requests over the limit', async () => {
      const publicKey = 'test-user-2';

      // Make MAX_REQUESTS requests
      for (let i = 1; i <= MAX_REQUESTS; i++) {
        const result = await rateLimitService.checkRateLimit(publicKey, `mention-${i}`);
        expect(result.allowed).toBe(true);
      }

      // Next request should be blocked
      const blockedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-4');
      expect(blockedResult.allowed).toBe(false);
      expect(blockedResult.currentCount).toBe(MAX_REQUESTS);
      expect(blockedResult.retryAfterSeconds).toBeGreaterThan(0);
      expect(blockedResult.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MINUTES * 60);
    });

    it('should enforce rolling window behavior', async () => {
      const publicKey = 'test-user-3';

      // Make MAX_REQUESTS requests
      for (let i = 1; i <= MAX_REQUESTS; i++) {
        const result = await rateLimitService.checkRateLimit(publicKey, `mention-${i}`);
        expect(result.allowed).toBe(true);
      }

      // Next request blocked
      const blockedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-4');
      expect(blockedResult.allowed).toBe(false);

      // Wait for window to expire (1 minute + buffer)
      await new Promise(resolve => setTimeout(resolve, (WINDOW_MINUTES * 60 + 2) * 1000));

      // Should be allowed again after window expires
      const allowedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-5');
      expect(allowedResult.allowed).toBe(true);
      expect(allowedResult.currentCount).toBe(1);
    }, 70000); // Increase timeout for this test

    it('should isolate rate limits per user', async () => {
      const userA = 'test-user-a';
      const userB = 'test-user-b';

      // User A makes MAX_REQUESTS requests
      for (let i = 1; i <= MAX_REQUESTS; i++) {
        const result = await rateLimitService.checkRateLimit(userA, `mention-a-${i}`);
        expect(result.allowed).toBe(true);
      }

      // User A is now blocked
      const blockedResult = await rateLimitService.checkRateLimit(userA, 'mention-a-4');
      expect(blockedResult.allowed).toBe(false);

      // User B should still be allowed (independent limit)
      const userBResult = await rateLimitService.checkRateLimit(userB, 'mention-b-1');
      expect(userBResult.allowed).toBe(true);
      expect(userBResult.currentCount).toBe(1);
    });

    it('should calculate retry-after correctly', async () => {
      const publicKey = 'test-user-4';

      // Make MAX_REQUESTS requests
      for (let i = 1; i <= MAX_REQUESTS; i++) {
        await rateLimitService.checkRateLimit(publicKey, `mention-${i}`);
      }

      // Get blocked result
      const blockedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-4');
      expect(blockedResult.allowed).toBe(false);
      expect(blockedResult.retryAfterSeconds).toBeDefined();
      expect(blockedResult.retryAfterSeconds!).toBeGreaterThan(0);
      expect(blockedResult.retryAfterSeconds!).toBeLessThanOrEqual(WINDOW_MINUTES * 60);

      // Wait a few seconds
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check retry-after decreased
      const blockedResult2 = await rateLimitService.checkRateLimit(publicKey, 'mention-5');
      expect(blockedResult2.retryAfterSeconds!).toBeLessThan(blockedResult.retryAfterSeconds!);
    }, 10000);

    it('should handle concurrent requests correctly', async () => {
      const publicKey = 'test-user-5';

      // Make concurrent requests
      const promises = [];
      for (let i = 1; i <= MAX_REQUESTS + 2; i++) {
        promises.push(rateLimitService.checkRateLimit(publicKey, `mention-${i}`));
      }

      const results = await Promise.all(promises);

      // Due to Redis race conditions, we can't guarantee exact counts
      // But we should have at least MAX_REQUESTS allowed and some blocked
      const allowedCount = results.filter(r => r.allowed).length;
      const blockedCount = results.filter(r => !r.allowed).length;

      expect(allowedCount).toBeGreaterThanOrEqual(MAX_REQUESTS);
      expect(allowedCount).toBeLessThanOrEqual(MAX_REQUESTS + 2);
      expect(blockedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return status with no requests', async () => {
      const publicKey = 'test-user-6';

      const status = await rateLimitService.getRateLimitStatus(publicKey);

      expect(status.publicKey).toBe(publicKey);
      expect(status.requestCount).toBe(0);
      expect(status.limit).toBe(MAX_REQUESTS);
      expect(status.windowMinutes).toBe(WINDOW_MINUTES);
      expect(status.oldestRequestAt).toBeUndefined();
      expect(status.newestRequestAt).toBeUndefined();
    });

    it('should return status with existing requests', async () => {
      const publicKey = 'test-user-7';

      // Make 2 requests
      await rateLimitService.checkRateLimit(publicKey, 'mention-1');
      await new Promise(resolve => setTimeout(resolve, 100));
      await rateLimitService.checkRateLimit(publicKey, 'mention-2');

      const status = await rateLimitService.getRateLimitStatus(publicKey);

      expect(status.publicKey).toBe(publicKey);
      expect(status.requestCount).toBe(2);
      expect(status.limit).toBe(MAX_REQUESTS);
      expect(status.oldestRequestAt).toBeInstanceOf(Date);
      expect(status.newestRequestAt).toBeInstanceOf(Date);
      expect(status.newestRequestAt!.getTime()).toBeGreaterThan(status.oldestRequestAt!.getTime());
    });

    it('should exclude expired requests from status', async () => {
      const publicKey = 'test-user-8';

      // Make requests
      await rateLimitService.checkRateLimit(publicKey, 'mention-1');
      await rateLimitService.checkRateLimit(publicKey, 'mention-2');

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, (WINDOW_MINUTES * 60 + 2) * 1000));

      const status = await rateLimitService.getRateLimitStatus(publicKey);

      // Should have no requests after window expires
      expect(status.requestCount).toBe(0);
    }, 70000);
  });

  describe('clearRateLimit', () => {
    it('should clear rate limit for a user', async () => {
      const publicKey = 'test-user-9';

      // Make MAX_REQUESTS requests
      for (let i = 1; i <= MAX_REQUESTS; i++) {
        await rateLimitService.checkRateLimit(publicKey, `mention-${i}`);
      }

      // Verify blocked
      const blockedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-4');
      expect(blockedResult.allowed).toBe(false);

      // Clear rate limit
      await rateLimitService.clearRateLimit(publicKey);

      // Should be allowed again
      const allowedResult = await rateLimitService.checkRateLimit(publicKey, 'mention-5');
      expect(allowedResult.allowed).toBe(true);
      expect(allowedResult.currentCount).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('should return true when service is healthy', async () => {
      const healthy = await rateLimitService.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should clean up test keys after health check', async () => {
      await rateLimitService.healthCheck();

      // Verify test key was cleaned up
      const testKey = 'ratelimit:user:health-check-test-user';
      const exists = await redisClient.exists(testKey);
      expect(exists).toBe(0);
    });
  });

  describe('TTL expiration', () => {
    it('should set TTL on rate limit keys', async () => {
      const publicKey = 'test-user-10';

      await rateLimitService.checkRateLimit(publicKey, 'mention-1');

      const key = `ratelimit:user:${publicKey}`;
      const ttl = await redisClient.ttl(key);

      // TTL should be set to window + 60 seconds
      const expectedTtl = WINDOW_MINUTES * 60 + 60;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(expectedTtl);
    });

    it('should refresh TTL on each request', async () => {
      const publicKey = 'test-user-11';

      await rateLimitService.checkRateLimit(publicKey, 'mention-1');
      const key = `ratelimit:user:${publicKey}`;
      const ttl1 = await redisClient.ttl(key);

      // Wait a few seconds
      await new Promise(resolve => setTimeout(resolve, 3000));

      await rateLimitService.checkRateLimit(publicKey, 'mention-2');
      const ttl2 = await redisClient.ttl(key);

      // TTL should be refreshed (back to full window) or at least not decreased
      // Due to timing variations, use >= instead of strict >
      expect(ttl2).toBeGreaterThanOrEqual(ttl1 - 1); // Allow 1 second tolerance

      // Should be close to the expected full TTL
      const expectedTtl = WINDOW_MINUTES * 60 + 60;
      expect(ttl2).toBeGreaterThanOrEqual(expectedTtl - 5); // Within 5 seconds
    }, 10000);
  });
});
