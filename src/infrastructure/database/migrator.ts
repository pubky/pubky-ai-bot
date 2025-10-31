import fs from 'fs/promises';
import path from 'path';
import { db } from './connection';
import logger from '@/utils/logger';

interface Migration {
  id: number;
  filename: string;
  sql: string;
}

export class DatabaseMigrator {
  private migrationsPath = path.join(__dirname, 'migrations');

  async createMigrationsTable(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async getAppliedMigrations(): Promise<number[]> {
    const rows = await db.query<{ id: number }>('SELECT id FROM migrations ORDER BY id');
    return rows.map(row => row.id);
  }

  async loadMigrations(): Promise<Migration[]> {
    const files = await fs.readdir(this.migrationsPath);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    const migrations: Migration[] = [];
    for (const filename of sqlFiles) {
      const match = filename.match(/^(\d+)_/);
      if (!match) {
        logger.warn(`Skipping migration file with invalid format: ${filename}`);
        continue;
      }

      const id = parseInt(match[1], 10);
      const filepath = path.join(this.migrationsPath, filename);
      const sql = await fs.readFile(filepath, 'utf-8');

      migrations.push({ id, filename, sql });
    }

    return migrations;
  }

  async runMigrations(): Promise<void> {
    logger.info('Starting database migrations...');

    await this.createMigrationsTable();
    const appliedMigrations = await this.getAppliedMigrations();
    const allMigrations = await this.loadMigrations();

    const pendingMigrations = allMigrations.filter(
      migration => !appliedMigrations.includes(migration.id)
    );

    if (pendingMigrations.length === 0) {
      logger.info('No pending migrations');
      return;
    }

    for (const migration of pendingMigrations) {
      logger.info(`Applying migration ${migration.id}: ${migration.filename}`);

      await db.transaction(async (client) => {
        // Execute the migration SQL
        await client.query(migration.sql);

        // Record the migration as applied
        await client.query(
          'INSERT INTO migrations (id, filename) VALUES ($1, $2)',
          [migration.id, migration.filename]
        );
      });

      logger.info(`Migration ${migration.id} applied successfully`);
    }

    logger.info(`Applied ${pendingMigrations.length} migrations`);
  }
}

// CLI runner
if (require.main === module) {
  const migrator = new DatabaseMigrator();
  migrator.runMigrations()
    .then(() => {
      logger.info('Migrations completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration failed:', error);
      process.exit(1);
    });
}