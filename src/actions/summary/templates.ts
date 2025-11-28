import { SummaryResult } from '@/services/summary';
import { ReplyContent } from '@/services/reply';

export class SummaryTemplates {
  static formatReply(result: SummaryResult): ReplyContent {
    const { summary, keyPoints, metrics } = result;

    // Build the summary text (without participant names)
    let formattedSummary = summary;

    // Determine if we should include key points based on space and quality
    const shouldIncludeKeyPoints =
      keyPoints.length > 0 &&
      metrics.confidence !== 'low' &&
      formattedSummary.length < 300; // Leave room for key points

    const replyContent: ReplyContent = {
      summary: formattedSummary
    };

    if (shouldIncludeKeyPoints) {
      replyContent.keyPoints = keyPoints;
    }


    return replyContent;
  }

  static formatMetrics(result: SummaryResult): Record<string, any> {
    return {
      type: 'summary',
      originalTokens: result.metrics.originalTokens,
      summaryTokens: result.metrics.summaryTokens,
      compressionRatio: result.metrics.compressionRatio,
      confidence: result.metrics.confidence,
      keyPointsCount: result.keyPoints.length,
      participantsCount: result.participants.length,
      topicsCount: result.topics.length
    };
  }

  static formatArtifacts(result: SummaryResult): Record<string, any> {
    return {
      summary: result.summary,
      keyPoints: result.keyPoints,
      participants: result.participants,
      participantNames: result.participantNames, // Include resolved usernames
      topics: result.topics,
      metrics: result.metrics
    };
  }

  static formatBriefSummary(result: SummaryResult): string {
    // Ultra-brief format for inline mentions or space-constrained contexts
    let brief = result.summary;

    if (result.keyPoints.length > 0 && brief.length < 200) {
      const topKeyPoint = result.keyPoints[0];
      brief += ` Key point: ${topKeyPoint}`;
    }

    return brief;
  }

  static formatDetailedSummary(result: SummaryResult): string {
    // Detailed format with all available information
    let detailed = `Summary: ${result.summary}`;

    if (result.keyPoints.length > 0) {
      detailed += '\n\nKey Points:\n';
      result.keyPoints.forEach(point => {
        detailed += `• ${point}\n`;
      });
    }

    // Participant mentions removed as per requirement

    if (result.topics.length > 0) {
      detailed += `\nTopics: ${result.topics.join(', ')}`;
    }

    // Add metadata for transparency
    if (result.metrics.confidence === 'low') {
      detailed += '\n\nWARNING: Summary confidence is low - thread may be incomplete or very complex.';
    }

    return detailed;
  }

  static formatErrorFallback(error: string): ReplyContent {
    return {
      summary: "I'm unable to provide a summary right now due to a technical issue. Please try again later.",
      keyPoints: []
    };
  }

  static shouldUseBriefFormat(result: SummaryResult): boolean {
    // Use brief format for:
    // - Simple threads (< 5 posts)
    // - High compression ratio (already concise)
    // - Space constraints

    return (
      result.metrics.originalTokens < 1000 ||
      result.metrics.compressionRatio > 0.8 ||
      result.keyPoints.length === 0
    );
  }
}