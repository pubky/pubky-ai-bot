import { db } from '@/infrastructure/database/connection';
import logger from '@/utils/logger';

export interface UsageRecord {
  mentionId: string;
  publicKey: string;
  phase: string; // 'summary' | 'factcheck_extract' | 'factcheck_verify' | ...
  provider?: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  meta?: Record<string, any>;
}

/**
 * BudgetService records per-mention token usage and can report per-user totals.
 * Enforcement hooks can be added later to block work when a user exceeds limits.
 */
export class BudgetService {
  async recordUsage(record: UsageRecord): Promise<void> {
    try {
      if (!record.totalTokens && !record.inputTokens && !record.outputTokens) {
        // Nothing to record
        return;
      }

      await db.query(
        `INSERT INTO token_usage (mention_id, public_key, phase, provider, model, input_tokens, output_tokens, total_tokens, meta_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.mentionId,
          record.publicKey,
          record.phase,
          record.provider || null,
          record.model || null,
          record.inputTokens ?? null,
          record.outputTokens ?? null,
          record.totalTokens ?? null,
          record.meta ? JSON.stringify(record.meta) : null
        ]
      );
    } catch (error) {
      logger.warn('Failed to record token usage', {
        error: error instanceof Error ? error.message : String(error),
        mentionId: record.mentionId,
        publicKey: record.publicKey,
        phase: record.phase
      });
    }
  }

  async getAuthorByMentionId(mentionId: string): Promise<string | null> {
    try {
      const rows = await db.query<{ author_id: string }>(
        'SELECT author_id FROM mentions WHERE mention_id = $1 LIMIT 1',
        [mentionId]
      );
      return rows[0]?.author_id || null;
    } catch (error) {
      logger.warn('Failed to resolve author by mentionId', {
        mentionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async getDailyUsage(publicKey: string): Promise<number> {
    const rows = await db.query<{ total: string | null }>(
      `SELECT SUM(total_tokens)::text AS total
         FROM token_usage
        WHERE public_key = $1
          AND created_at >= date_trunc('day', now())`,
      [publicKey]
    );
    const val = rows[0]?.total ? parseInt(rows[0].total, 10) : 0;
    return isNaN(val) ? 0 : val;
  }
}

export const budgetService = new BudgetService();

