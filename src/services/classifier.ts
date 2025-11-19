import { z } from 'zod';
import { AIService } from './ai';
import { RoutingDecision, HeuristicMatch, ClassificationRequest } from '@/orchestration/types';
import { Mention } from '@/types/mention';
import logger from '@/utils/logger';
import { extractKeywords } from '@/utils/text';

const IntentSchema = z.object({
  intent: z.enum(['summary', 'factcheck', 'unknown']),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional()
});

export class ClassifierService {
  private readonly summaryKeywords = [
    'summary', 'summarize', 'tl;dr', 'tldr', 'sum up', 'recap', 'overview'
  ];

  private readonly factcheckKeywords = [
    // Explicit fact-checking terms
    'verify', 'fact check', 'factcheck', 'fact-check',

    // Truth verification patterns
    'is this true', 'is this tru', 'is this real', 'is this legit',
    'true or false', 'real or fake', 'legit or fake',

    // Source/citation requests
    'source', 'citation', 'cite', 'cite this', 'sources',

    // Verification actions
    'verify this', 'check this', 'confirm this', 'validate this',

    // Authenticity checks
    'accurate', 'authentic', 'genuine', 'legitimate', 'legit',

    // Debunking patterns
    'debunk', 'hoax', 'fake news', 'misinformation', 'disinformation'
  ];

  constructor(private aiService: AIService) {}

  heuristicIntent(mention: Mention): HeuristicMatch | null {
    const content = mention.content.toLowerCase();
    const keywords = extractKeywords(content);

    // Check for summary indicators
    const summaryMatches = this.summaryKeywords.filter(keyword =>
      content.includes(keyword) || keywords.includes(keyword)
    );

    // Check for factcheck indicators
    const factcheckMatches = this.factcheckKeywords.filter(keyword =>
      content.includes(keyword) || keywords.includes(keyword)
    );

    // Priority: factcheck > summary
    if (factcheckMatches.length > 0) {
      return {
        intent: 'factcheck',
        confidence: Math.min(0.85, 0.5 + (factcheckMatches.length * 0.1)),
        matchedKeywords: factcheckMatches,
        reason: `Matched factcheck keywords: ${factcheckMatches.join(', ')}`
      };
    }

    if (summaryMatches.length > 0) {
      return {
        intent: 'summary',
        confidence: Math.min(0.85, 0.4 + (summaryMatches.length * 0.1)),
        matchedKeywords: summaryMatches,
        reason: `Matched summary keywords: ${summaryMatches.join(', ')}`
      };
    }

    return null;
  }

  async classifyIntent(request: ClassificationRequest): Promise<RoutingDecision> {
    try {
      const prompt = this.buildClassificationPrompt(request);

      logger.debug('Classifying intent with LLM', {
        contentLength: request.content.length,
        hasContext: !!request.context
      });

      const result = await this.aiService.generateObject(
        prompt,
        IntentSchema,
        'classifier'
      );

      const decision: RoutingDecision = {
        intent: (result.object as any).intent,
        confidence: (result.object as any).confidence,
        reason: (result.object as any).reason,
        method: 'llm'
      };

      logger.debug('LLM classification completed', decision);
      return decision;

    } catch (error) {
      logger.error('LLM classification failed:', error);

      // Fallback to unknown with low confidence
      return {
        intent: 'unknown',
        confidence: 0.1,
        reason: 'LLM classification failed, defaulting to unknown',
        method: 'llm'
      };
    }
  }

  private buildClassificationPrompt(request: ClassificationRequest): string {
    let prompt = `You are an intent classifier for a Pubky bot that provides two main services:

1. SUMMARY: Summarizes long threads or conversations into key points
2. FACTCHECK: Verifies claims against reliable sources using web search

Analyze this mention and classify the intent:

Content: "${request.content}"`;

    if (request.context) {
      prompt += `

Context:
- Author: ${request.context.authorId}
- Post ID: ${request.context.postId}
- Has thread: ${request.context.hasThread}`;
    }

    prompt += `

Classification rules:
- SUMMARY: User wants a summary, recap, overview, or tl;dr of content
- FACTCHECK: User wants to verify claims, check facts, or find sources
  Examples: "is this true", "is this tru", "is this real", "is this legit",
  "verify this", "check this", "source", "real or fake", "true or false",
  "debunk", "fact check", "misinformation", "authentic"
- UNKNOWN: Intent is unclear or requests something else

IMPORTANT: Questions about truthfulness, authenticity, or legitimacy should be FACTCHECK, not SUMMARY.

Return ONLY valid JSON with this exact structure:
{
  "intent": "summary|factcheck|unknown",
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`;

    return prompt;
  }

  async routeMention(mention: Mention): Promise<RoutingDecision> {
    // Try heuristics first (fast path)
    const heuristicMatch = this.heuristicIntent(mention);

    // Use heuristics if confidence is moderate or higher (≥0.6)
    // This avoids LLM calls for obvious cases while maintaining accuracy
    if (heuristicMatch && heuristicMatch.confidence >= 0.6) {
      logger.debug('Using heuristic classification (high confidence)', {
        mentionId: mention.mentionId,
        intent: heuristicMatch.intent,
        confidence: heuristicMatch.confidence,
        keywords: heuristicMatch.matchedKeywords
      });

      return {
        intent: heuristicMatch.intent,
        confidence: heuristicMatch.confidence,
        reason: heuristicMatch.reason,
        method: 'heuristic'
      };
    }

    // Fall back to LLM classification for uncertain cases
    logger.debug('Falling back to LLM classification', {
      mentionId: mention.mentionId,
      heuristicConfidence: heuristicMatch?.confidence || 0,
      reason: heuristicMatch ? 'confidence below threshold' : 'no keyword match'
    });

    const request: ClassificationRequest = {
      content: mention.content,
      context: {
        authorId: mention.authorId,
        postId: mention.postId,
        hasThread: true // We'll assume threads exist for now
      }
    };

    return this.classifyIntent(request);
  }
}