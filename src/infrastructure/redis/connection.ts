import { createClient, RedisClientType } from 'redis';
import logger from '@/utils/logger';
import appConfig from '@/config';

export class RedisConnection {
  private client: RedisClientType;
  private subscriber: RedisClientType;

  constructor() {
    this.client = createClient({ url: appConfig.redis.url });
    this.subscriber = createClient({ url: appConfig.redis.url });

    this.client.on('error', (err) => {
      logger.error('Redis client error:', err);
    });

    this.subscriber.on('error', (err) => {
      logger.error('Redis subscriber error:', err);
    });
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.client.connect(),
      this.subscriber.connect()
    ]);
    logger.info('Redis connections established');
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.client.disconnect(),
      this.subscriber.disconnect()
    ]);
    logger.info('Redis connections closed');
  }

  getClient(): RedisClientType {
    return this.client;
  }

  getSubscriber(): RedisClientType {
    return this.subscriber;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed:', error);
      return false;
    }
  }
}

export const redis = new RedisConnection();