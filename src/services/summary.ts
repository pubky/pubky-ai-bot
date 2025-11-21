import { AIService } from './ai';
import { ThreadContext } from '@/types/thread';
import { InjectionDetector } from './injection-detector';
import { SecurePrompts } from './secure-prompts';
import logger from '@/utils/logger';
import { truncateText } from '@/utils/text';
import appConfig from '@/config';

export interface SummaryOptions {
  maxKeyPoints?: number;
  includeParticipants?: boolean;
  includeTopics?: boolean;
  style?: 'brief' | 'detailed';
}

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  participants: string[]; // Keep for backward compatibility
  participantNames: string[]; // New field with resolved usernames
  topics: string[];
  metrics: {
    originalTokens: number;
    summaryTokens: number;
    compressionRatio: number;
    confidence: 'high' | 'medium' | 'low';
    aiTokensUsed?: number; // actual provider-reported tokens if available
  };
  aiMeta?: {
    provider?: string;
    model?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
}

export class SummaryService {
  private injectionDetector: InjectionDetector;

  constructor(private aiService: AIService) {
    this.injectionDetector = new InjectionDetector();
  }

  async generate(
    context: ThreadContext,
    options: SummaryOptions = {}
  ): Promise<SummaryResult> {
    try {
      logger.debug('Generating summary', {
        postCount: context.posts.length,
        participants: context.participants.length,
        totalTokens: context.totalTokens
      });

      // Use configured token limit for AI processing
      if (context.totalTokens > appConfig.limits.thread.maxTokensForAI) {
        logger.info('Using fallback summary for very large thread', {
          totalTokens: context.totalTokens,
          maxTokensForAI: appConfig.limits.thread.maxTokensForAI
        });
        return this.generateFallbackSummary(context, options);
      }

      // Build prompt for AI summary
      const prompt = this.buildSummaryPrompt(context, options);

      // Generate summary using AI
      const result = await this.aiService.generateText(prompt, 'summary');

      // Parse and structure the result
      const summaryResult = this.parseSummaryResult(result.text, context, options);

      // Attach provider usage metadata when available
      try {
        const total = result.usage?.totalTokens;
        if (typeof total === 'number') {
          (summaryResult.metrics as any).aiTokensUsed = total;
        }
        summaryResult.aiMeta = {
          provider: result.provider,
          model: appConfig.ai.models.summary,
          usage: result.usage ? {
            inputTokens: (result.usage as any).inputTokens,
            outputTokens: (result.usage as any).outputTokens,
            totalTokens: (result.usage as any).totalTokens
          } : undefined
        };
      } catch {}

      logger.debug('Summary generated successfully', {
        summaryLength: summaryResult.summary.length,
        keyPointsCount: summaryResult.keyPoints.length,
        compressionRatio: summaryResult.metrics.compressionRatio
      });

      return summaryResult;

    } catch (error) {
      logger.error('Failed to generate summary:', error);

      // Fallback to basic summary
      logger.info('Using fallback summary due to error');
      return this.generateFallbackSummary(context, options);
    }
  }

  private buildSummaryPrompt(context: ThreadContext, options: SummaryOptions): string {
    const style = options.style || 'brief';
    const maxKeyPoints = options.maxKeyPoints || 3;
    const MAX_TOKENS = 50000; // 50k token limit

    // Detect and sanitize root post
    const rootDetection = this.injectionDetector.detect(context.rootPost.content, {
      postId: context.rootPost.id,
      authorId: context.rootPost.authorId,
      postUri: context.rootPost.uri
    });

    // Get all non-root posts
    const threadPosts = context.posts.filter(p => p.id !== context.rootPost.id);

    // Calculate approximate token count (rough estimate: 1 token ≈ 4 chars)
    let totalTokens = Math.ceil(rootDetection.sanitized.length / 4);
    const sanitizedPosts: string[] = [];

    // Include posts until we hit the token limit
    for (const post of threadPosts) {
      const detection = this.injectionDetector.detect(post.content, {
        postId: post.id,
        authorId: post.authorId,
        postUri: post.uri
      });

      const postTokens = Math.ceil(detection.sanitized.length / 4);
      if (totalTokens + postTokens > MAX_TOKENS) {
        logger.info('Thread truncated due to token limit', {
          totalPosts: threadPosts.length,
          includedPosts: sanitizedPosts.length,
          estimatedTokens: totalTokens
        });
        break;
      }

      sanitizedPosts.push(detection.sanitized);
      totalTokens += postTokens;
    }

    // Use secure prompt template
    return SecurePrompts.buildSummaryPrompt(
      rootDetection.sanitized,
      sanitizedPosts,
      {
        style,
        maxKeyPoints
      }
    );
  }

  private parseSummaryResult(
    aiResponse: string,
    context: ThreadContext,
    options: SummaryOptions
  ): SummaryResult {
    const lines = aiResponse.split('\n').map(line => line.trim()).filter(Boolean);

    let summary = '';
    const keyPoints: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('Summary:')) {
        summary = line.replace('Summary:', '').trim();
      } else if (line.startsWith('•') || line.startsWith('-')) {
        const point = line.replace(/^[•-]\s*/, '').trim();
        if (point && keyPoints.length < (options.maxKeyPoints || 3)) {
          keyPoints.push(point);
        }
      } else if (!summary && !line.includes(':')) {
        // Fallback: treat as summary if no explicit format
        summary = line;
      }
    }

    // Fallback if parsing failed
    if (!summary) {
      summary = truncateText(aiResponse, 200);
    }

    // Calculate metrics
    const summaryTokens = Math.ceil((summary + keyPoints.join(' ')).length / 4);
    const compressionRatio = context.totalTokens > 0 ? summaryTokens / context.totalTokens : 1;

    // Determine confidence based on thread completeness and compression
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (context.isComplete && compressionRatio < 0.3) {
      confidence = 'high';
    } else if (!context.isComplete || compressionRatio > 0.7) {
      confidence = 'low';
    }

    // Get participant names from profiles if available
    const participantNames = context.participantProfiles
      ? context.participantProfiles.slice(0, 5).map(p => p.displayName)
      : context.participants.slice(0, 5);

    return {
      summary: truncateText(summary, 400),
      keyPoints,
      participants: context.participants.slice(0, 5),
      participantNames,
      topics: context.metadata?.topics || [],
      metrics: {
        originalTokens: context.totalTokens,
        summaryTokens,
        compressionRatio,
        confidence
      }
    };
  }

  private generateFallbackSummary(
    context: ThreadContext,
    options: SummaryOptions
  ): SummaryResult {
    // Simple extraction-based summary for large threads or errors
    const rootContent = context.rootPost.content;
    const participantCount = context.participants.length;
    const postCount = context.posts.length;

    let summary = `Discussion thread`;
    if (rootContent.length > 50) {
      summary = `Discussion about: ${truncateText(rootContent, 100)}`;
    }

    summary += ` (${postCount} posts, ${participantCount} participants)`;

    const keyPoints: string[] = [];

    if (context.metadata?.topics && context.metadata.topics.length > 0) {
      keyPoints.push(`Main topics: ${context.metadata.topics.slice(0, 3).join(', ')}`);
    }

    if (postCount > 10) {
      keyPoints.push('Extended discussion with multiple viewpoints');
    }

    if (!context.isComplete) {
      keyPoints.push('Thread may be incomplete');
    }

    // Get participant names from profiles if available
    const participantNames = context.participantProfiles
      ? context.participantProfiles.slice(0, 5).map(p => p.displayName)
      : context.participants.slice(0, 5);

    return {
      summary: truncateText(summary, 300),
      keyPoints: keyPoints.slice(0, options.maxKeyPoints || 3),
      participants: context.participants.slice(0, 5),
      participantNames,
      topics: context.metadata?.topics || [],
      metrics: {
        originalTokens: context.totalTokens,
        summaryTokens: Math.ceil(summary.length / 4),
        compressionRatio: 0.9, // Conservative estimate for fallback
        confidence: 'low'
      }
    };
  }
}
