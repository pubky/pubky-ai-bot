import { Pool, PoolClient } from 'pg';
import logger from '@/utils/logger';
import appConfig from '@/config';

export class DatabaseConnection {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: appConfig.postgresql.url,
      max: appConfig.postgresql.poolSize,
      ssl: appConfig.postgresql.ssl
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client:', err);
    });
  }

  async query<T = any>(text: string, params?: any[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(text, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database connection pool closed');
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('Database health check failed:', error);
      return false;
    }
  }
}

export const db = new DatabaseConnection();