import { createClient, RedisClientType } from 'redis';
import { BlacklistService } from '../blacklist';

describe('BlacklistService', () => {
  let redisClient: RedisClientType;
  let blacklistService: BlacklistService;

  const TEST_KEYS = [
    'pk:test-blacklisted-1',
    'pk:test-blacklisted-2',
    'pk:test-blacklisted-3'
  ];

  beforeAll(async () => {
    // Connect to Redis test instance
    redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379/0' });
    await redisClient.connect();
  });

  afterAll(async () => {
    await redisClient.disconnect();
  });

  beforeEach(async () => {
    // Clear blacklist before each test
    try {
      await redisClient.del('blacklist:pubkey');
    } catch (error) {
      // Key might not exist, that's ok
    }

    // Create fresh service instance with initial blacklist
    blacklistService = new BlacklistService(redisClient, TEST_KEYS);

    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await redisClient.del('blacklist:pubkey');
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize with empty blacklist', async () => {
      const emptyService = new BlacklistService(redisClient, []);
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await emptyService.checkBlacklist('any-key');
      expect(result.allowed).toBe(true);
      expect(result.isBlacklisted).toBe(false);
    });

    it('should initialize Redis SET with configured blacklist', async () => {
      // Check that all test keys are in Redis
      for (const key of TEST_KEYS) {
        const isMember = await redisClient.sIsMember('blacklist:pubkey', key);
        expect(isMember).toBe(true);
      }
    });

    it('should log initialization with blacklist count', async () => {
      const blacklist = await redisClient.sMembers('blacklist:pubkey');
      expect(blacklist.length).toBeGreaterThanOrEqual(TEST_KEYS.length);
    });
  });

  describe('checkBlacklist', () => {
    it('should allow non-blacklisted public keys', async () => {
      const result = await blacklistService.checkBlacklist('pk:allowed-user');

      expect(result.allowed).toBe(true);
      expect(result.isBlacklisted).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should block blacklisted public keys', async () => {
      const result = await blacklistService.checkBlacklist(TEST_KEYS[0]);

      expect(result.allowed).toBe(false);
      expect(result.isBlacklisted).toBe(true);
      expect(result.reason).toBe('Public key is blacklisted');
    });

    it('should handle multiple blacklisted keys', async () => {
      for (const key of TEST_KEYS) {
        const result = await blacklistService.checkBlacklist(key);
        expect(result.allowed).toBe(false);
        expect(result.isBlacklisted).toBe(true);
      }
    });

    it('should be case-sensitive', async () => {
      const upperKey = TEST_KEYS[0].toUpperCase();
      const result = await blacklistService.checkBlacklist(upperKey);

      // Should be allowed since exact match required
      expect(result.allowed).toBe(true);
    });

    it('should handle concurrent checks', async () => {
      const keys = [
        ...TEST_KEYS,  // Should be blocked
        'pk:allowed-1', 'pk:allowed-2', 'pk:allowed-3'  // Should be allowed
      ];

      const results = await Promise.all(
        keys.map(key => blacklistService.checkBlacklist(key))
      );

      // First 3 should be blocked
      expect(results[0].isBlacklisted).toBe(true);
      expect(results[1].isBlacklisted).toBe(true);
      expect(results[2].isBlacklisted).toBe(true);

      // Next 3 should be allowed
      expect(results[3].isBlacklisted).toBe(false);
      expect(results[4].isBlacklisted).toBe(false);
      expect(results[5].isBlacklisted).toBe(false);
    });
  });

  describe('fail-open behavior', () => {
    it('should allow requests when Redis is unavailable', async () => {
      // Disconnect Redis to simulate failure
      await redisClient.disconnect();

      const result = await blacklistService.checkBlacklist('any-key');

      // Should fail open (allow request)
      expect(result.allowed).toBe(true);
      expect(result.isBlacklisted).toBe(false);

      // Reconnect for cleanup
      await redisClient.connect();
    });
  });

  describe('addToBlacklist', () => {
    it('should add a public key to blacklist', async () => {
      const newKey = 'pk:newly-blacklisted';

      // Verify not blacklisted initially
      let result = await blacklistService.checkBlacklist(newKey);
      expect(result.isBlacklisted).toBe(false);

      // Add to blacklist
      await blacklistService.addToBlacklist(newKey);

      // Verify now blacklisted
      result = await blacklistService.checkBlacklist(newKey);
      expect(result.isBlacklisted).toBe(true);
    });

    it('should handle adding duplicate keys gracefully', async () => {
      const key = 'pk:duplicate-test';

      await blacklistService.addToBlacklist(key);
      await blacklistService.addToBlacklist(key); // Add again

      // Should still be blacklisted (no error)
      const result = await blacklistService.checkBlacklist(key);
      expect(result.isBlacklisted).toBe(true);
    });

    it('should persist across service instances', async () => {
      const key = 'pk:persistent-test';
      await blacklistService.addToBlacklist(key);

      // Create new service instance
      const newService = new BlacklistService(redisClient, []);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still be blacklisted
      const result = await newService.checkBlacklist(key);
      expect(result.isBlacklisted).toBe(true);
    });
  });

  describe('removeFromBlacklist', () => {
    it('should remove a public key from blacklist', async () => {
      const key = TEST_KEYS[0];

      // Verify blacklisted initially
      let result = await blacklistService.checkBlacklist(key);
      expect(result.isBlacklisted).toBe(true);

      // Remove from blacklist
      await blacklistService.removeFromBlacklist(key);

      // Verify now allowed
      result = await blacklistService.checkBlacklist(key);
      expect(result.isBlacklisted).toBe(false);
    });

    it('should handle removing non-existent keys gracefully', async () => {
      const key = 'pk:non-existent';

      // Should not throw error
      await expect(
        blacklistService.removeFromBlacklist(key)
      ).resolves.not.toThrow();
    });
  });

  describe('getBlacklist', () => {
    it('should return all blacklisted keys', async () => {
      const blacklist = await blacklistService.getBlacklist();

      expect(blacklist).toBeInstanceOf(Array);
      expect(blacklist.length).toBeGreaterThanOrEqual(TEST_KEYS.length);

      // Should contain all test keys
      for (const key of TEST_KEYS) {
        expect(blacklist).toContain(key);
      }
    });

    it('should return empty array when no keys blacklisted', async () => {
      await blacklistService.clearBlacklist();

      const blacklist = await blacklistService.getBlacklist();
      expect(blacklist).toEqual([]);
    });

    it('should reflect additions and removals', async () => {
      const newKey = 'pk:dynamic-test';

      await blacklistService.addToBlacklist(newKey);
      let blacklist = await blacklistService.getBlacklist();
      expect(blacklist).toContain(newKey);

      await blacklistService.removeFromBlacklist(newKey);
      blacklist = await blacklistService.getBlacklist();
      expect(blacklist).not.toContain(newKey);
    });
  });

  describe('clearBlacklist', () => {
    it('should remove all blacklisted keys', async () => {
      // Verify keys exist
      let blacklist = await blacklistService.getBlacklist();
      expect(blacklist.length).toBeGreaterThan(0);

      // Clear blacklist
      await blacklistService.clearBlacklist();

      // Verify empty
      blacklist = await blacklistService.getBlacklist();
      expect(blacklist).toEqual([]);
    });

    it('should allow all keys after clearing', async () => {
      await blacklistService.clearBlacklist();

      for (const key of TEST_KEYS) {
        const result = await blacklistService.checkBlacklist(key);
        expect(result.isBlacklisted).toBe(false);
        expect(result.allowed).toBe(true);
      }
    });
  });

  describe('healthCheck', () => {
    it('should return true when Redis is healthy', async () => {
      const healthy = await blacklistService.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when Redis is unavailable', async () => {
      await redisClient.disconnect();

      const healthy = await blacklistService.healthCheck();
      expect(healthy).toBe(false);

      // Reconnect for cleanup
      await redisClient.connect();
    });

    it('should not modify blacklist during health check', async () => {
      const beforeCount = (await blacklistService.getBlacklist()).length;

      await blacklistService.healthCheck();

      const afterCount = (await blacklistService.getBlacklist()).length;
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('O(1) performance', () => {
    it('should check membership in constant time', async () => {
      // Add many keys to test O(1) performance
      const manyKeys = Array.from({ length: 1000 }, (_, i) => `pk:test-${i}`);
      await redisClient.sAdd('blacklist:pubkey', manyKeys);

      // Check a key (should be O(1))
      const startTime = Date.now();
      await blacklistService.checkBlacklist(manyKeys[500]);
      const duration = Date.now() - startTime;

      // Should be very fast (< 10ms)
      expect(duration).toBeLessThan(10);
    });
  });
});
