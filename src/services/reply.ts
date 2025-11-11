import { PubkyService, PublishReplyResult } from './pubky';
import { SafetyService } from './safety';
import { db } from '@/infrastructure/database/connection';
import logger from '@/utils/logger';
import { truncateText } from '@/utils/text';

export interface ReplyContent {
  summary?: string;
  verdict?: string;
  sources?: Array<{
    title: string;
    url: string;
    description?: string;
  }>;
  keyPoints?: string[];
  confidence?: 'high' | 'medium' | 'low';
}

export interface ReplyRef {
  id: string;
  uri: string;
  content: string;
  parentUri: string;
}

export class ReplyService {
  constructor(
    private pubkyService: PubkyService,
    private safetyService: SafetyService
  ) {}

  compose(content: ReplyContent): string {
    if (content.summary) {
      return this.composeSummaryReply(content);
    } else if (content.verdict) {
      return this.composeFactcheckReply(content);
    } else {
      throw new Error('Reply content must include either summary or verdict');
    }
  }

  private composeSummaryReply(content: ReplyContent): string {
    let reply = content.summary || '';

    if (content.keyPoints && content.keyPoints.length > 0) {
      const bullets = content.keyPoints
        .slice(0, 3) // Maximum 3 key points
        .map(point => `• ${point}`)
        .join('\n');

      reply += `\n\n${bullets}`;
    }

    return truncateText(reply, 800);
  }

  private composeFactcheckReply(content: ReplyContent): string {
    let reply = content.verdict || '';

    if (content.sources && content.sources.length > 0) {
      reply += '\n\nSources:';

      content.sources.slice(0, 3).forEach(source => {
        // Include credibility explanation if available (Grok-style)
        if (source.description) {
          reply += `\n\n• ${source.title}\n  ${source.url}\n  ${source.description}`;
        } else {
          reply += `\n• ${source.title} — ${source.url}`;
        }
      });
    }

    return truncateText(reply, 1200); // Increased from 800 to accommodate richer content
  }

  async publish(
    parentUri: string,
    content: string,
    mentionId: string
  ): Promise<ReplyRef> {
    try {
      // Safety check
      const safetyCheck = this.safetyService.performComprehensiveCheck(content);
      if (safetyCheck.blocked) {
        logger.warn('Reply blocked by safety check', {
          mentionId,
          reason: safetyCheck.reason,
          matches: safetyCheck.matches
        });

        // Use safe replacement
        content = this.safetyService.getSafeReplacementMessage();
      }

      // Check for duplicate replies
      const existingReply = await this.checkForDuplicate(mentionId, parentUri);
      if (existingReply) {
        logger.debug('Duplicate reply detected, returning existing', {
          mentionId,
          existingReplyId: existingReply.id
        });
        return existingReply;
      }

      // Publish via Pubky
      const result = await this.pubkyService.publishReply({
        parentUri,
        content
      });

      // Store in database for auditability
      const replyRef = await this.storeReply({
        mentionId,
        parentUri,
        replyUri: result.uri,
        content,
        replyId: result.id
      });

      logger.info('Reply published and stored', {
        mentionId,
        replyId: result.id,
        contentLength: content.length
      });

      return replyRef;

    } catch (error) {
      logger.error('Failed to publish reply:', error);
      throw error;
    }
  }

  private async checkForDuplicate(
    mentionId: string,
    parentUri: string
  ): Promise<ReplyRef | null> {
    try {
      const rows = await db.query<{
        id: string;
        reply_uri: string;
        content: string;
        parent_uri: string;
      }>(
        'SELECT id, reply_uri, content, parent_uri FROM replies WHERE mention_id = $1 AND parent_uri = $2',
        [mentionId, parentUri]
      );

      if (rows.length > 0) {
        const row = rows[0];
        return {
          id: row.id,
          uri: row.reply_uri,
          content: row.content,
          parentUri: row.parent_uri
        };
      }

      return null;
    } catch (error) {
      logger.error('Error checking for duplicate reply:', error);
      return null; // Continue with publishing on database error
    }
  }

  private async storeReply(data: {
    mentionId: string;
    parentUri: string;
    replyUri: string;
    content: string;
    replyId: string;
  }): Promise<ReplyRef> {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO replies (mention_id, parent_uri, reply_uri, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [data.mentionId, data.parentUri, data.replyUri, data.content]
    );

    return {
      id: rows[0].id,
      uri: data.replyUri,
      content: data.content,
      parentUri: data.parentUri
    };
  }

  async getReplyHistory(mentionId: string): Promise<ReplyRef[]> {
    const rows = await db.query<{
      id: string;
      reply_uri: string;
      content: string;
      parent_uri: string;
    }>(
      'SELECT id, reply_uri, content, parent_uri FROM replies WHERE mention_id = $1 ORDER BY created_at DESC',
      [mentionId]
    );

    return rows.map(row => ({
      id: row.id,
      uri: row.reply_uri,
      content: row.content,
      parentUri: row.parent_uri
    }));
  }
}