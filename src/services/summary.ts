import { AIService } from './ai';
import { ThreadContext } from '@/types/thread';
import logger from '@/utils/logger';
import { truncateText } from '@/utils/text';

export interface SummaryOptions {
  maxKeyPoints?: number;
  includeParticipants?: boolean;
  includeTopics?: boolean;
  style?: 'brief' | 'detailed';
}

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  participants: string[];
  topics: string[];
  metrics: {
    originalTokens: number;
    summaryTokens: number;
    compressionRatio: number;
    confidence: 'high' | 'medium' | 'low';
  };
}

export class SummaryService {
  constructor(private aiService: AIService) {}

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

      // Determine if we need to use fallback for very large threads
      if (context.totalTokens > 8000) {
        logger.info('Using fallback summary for large thread', {
          totalTokens: context.totalTokens
        });
        return this.generateFallbackSummary(context, options);
      }

      // Build prompt for AI summary
      const prompt = this.buildSummaryPrompt(context, options);

      // Generate summary using AI
      const result = await this.aiService.generateText(prompt, 'summary');

      // Parse and structure the result
      const summaryResult = this.parseSummaryResult(result.text, context, options);

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

    let prompt = `Please provide a ${style} summary of this conversation thread.

Thread Content:
Root Post: ${context.rootPost.content}
`;

    // Add recent posts (limit to most recent if thread is long)
    const recentPosts = context.posts
      .filter(p => p.id !== context.rootPost.id)
      .slice(-10); // Last 10 posts

    if (recentPosts.length > 0) {
      prompt += '\nRecent Posts:\n';
      recentPosts.forEach((post, index) => {
        prompt += `${index + 1}. ${post.content}\n`;
      });
    }

    prompt += `
Instructions:
- Provide a concise summary (1-2 sentences)
- Extract ${maxKeyPoints} key points as bullet points
- Keep total response under 500 characters for brief style, 800 for detailed
- Focus on main discussion topics and conclusions`;

    if (options.includeParticipants) {
      prompt += `\n- Note the main participants: ${context.participants.slice(0, 5).join(', ')}`;
    }

    prompt += `

Format your response exactly as:
Summary: [Your summary here]
Key Points:
• [Point 1]
• [Point 2]
• [Point 3]`;

    return prompt;
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

    return {
      summary: truncateText(summary, 400),
      keyPoints,
      participants: context.participants.slice(0, 5),
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

    return {
      summary: truncateText(summary, 300),
      keyPoints: keyPoints.slice(0, options.maxKeyPoints || 3),
      participants: context.participants.slice(0, 5),
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