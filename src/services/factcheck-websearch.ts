import { AIService } from './ai';
import { ThreadContext } from '@/types/thread';
import { InjectionDetector } from './injection-detector';
import { SecurePrompts } from './secure-prompts';
import logger from '@/utils/logger';
import appConfig from '@/config';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

export interface Claim {
  text: string;
  confidence: number;
  context?: string;
}

export interface Evidence {
  source: string;
  title: string;
  url: string;
  excerpt?: string;
  reliability: number;
  relevance: number;
}

export interface EnhancedEvidence extends Evidence {
  credibilityRating?: 'highly reliable' | 'generally reliable' | 'moderate' | 'questionable' | 'unknown';
  credibilityExplanation?: string;
  perspective?: string;
}

export interface VerifiedClaim {
  claim: string;
  verdict: string;
  confidence: number;
  evidence: EnhancedEvidence[];
  reasoning: string;
  alternativePerspectives?: string[];
}

export interface FactcheckResult {
  verifiedClaims: VerifiedClaim[];
  sources: EnhancedEvidence[];
  overallAssessment: {
    narrative: string;
    verdict?: string;
    confidence: number;
    reasoning: string;
  };
  metrics: {
    claimsProcessed: number;
    sourcesFound: number;
    searchQueries: number;
    processingTimeMs: number;
  };
}

// Zod schema for claim extraction
const ClaimsExtractionSchema = z.object({
  claims: z.array(z.object({
    text: z.string()
      .describe('The exact factual claim extracted from the text'),
    confidence: z.number()
      .min(0)
      .max(1)
      .describe('Confidence score (0-1) that this is a verifiable factual claim'),
    context: z.string().optional()
      .describe('Important context surrounding this claim, if relevant')
  }))
    .describe('List of verifiable factual claims found in the text')
});

// Zod schema for narrative verification output
const NarrativeVerificationSchema = z.object({
  narrativeSummary: z.string()
    .describe('Conversational 2-4 sentence explanation of findings, written like explaining to a friend, including nuances and source quality'),
  confidence: z.enum(['high', 'medium', 'low'])
    .describe('Confidence level with context'),
  confidenceReason: z.string()
    .describe('Brief explanation of confidence level'),
  alternativePerspectives: z.array(z.string()).optional()
    .describe('Other legitimate viewpoints or interpretations of this claim, if applicable')
});

interface CachedSearchResult {
  query: string;
  results: EnhancedEvidence[];
  timestamp: number;
}

/**
 * FactcheckWebSearchService - Uses OpenAI's native web search API
 * This is a simpler alternative to the MCP-based factcheck service
 */
export class FactcheckWebSearchService {
  private sourceCredibilityConfig: any;
  private searchCache: Map<string, CachedSearchResult>;
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds
  private injectionDetector: InjectionDetector;

  constructor(private aiService: AIService) {
    // Load source credibility configuration
    this.loadSourceCredibilityConfig();

    // Initialize search cache
    this.searchCache = new Map();

    // Initialize injection detector
    this.injectionDetector = new InjectionDetector();

    // Periodically clean up expired cache entries
    setInterval(() => this.cleanupCache(), 600000); // Clean up every 10 minutes
  }

  private cleanupCache(): void {
    const now = Date.now();
    const expired = Array.from(this.searchCache.entries())
      .filter(([_, value]) => now - value.timestamp > this.CACHE_TTL)
      .map(([key]) => key);

    expired.forEach(key => this.searchCache.delete(key));
  }

  private getCacheKey(query: string): string {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private getCachedResults(query: string): EnhancedEvidence[] | null {
    const cached = this.searchCache.get(this.getCacheKey(query));

    if (!cached) return null;

    const isValid = Date.now() - cached.timestamp <= this.CACHE_TTL;
    if (isValid) {
      logger.debug(`Cache hit: ${query.substring(0, 50)}`);
      return cached.results;
    }

    this.searchCache.delete(this.getCacheKey(query));
    return null;
  }

  private setCachedResults(query: string, results: EnhancedEvidence[]): void {
    this.searchCache.set(this.getCacheKey(query), {
      query,
      results,
      timestamp: Date.now()
    });
  }

  private loadSourceCredibilityConfig(): void {
    try {
      const configPath = path.join(process.cwd(), 'config', 'source-credibility.json');
      this.sourceCredibilityConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      logger.info(`Loaded ${Object.keys(this.sourceCredibilityConfig.sources).length} source credibility entries`);
    } catch {
      this.sourceCredibilityConfig = {
        sources: {},
        domainRules: {
          '.gov': { score: 0.8, reason: 'Government source' },
          '.edu': { score: 0.85, reason: 'Educational institution' },
          '.org': { score: 0.7, reason: 'Organization' }
        },
        categoryDefaults: { unknown: 0.5 },
        config: { defaultScore: 0.5 }
      };
      logger.warn('Using default source credibility config');
    }
  }

  async extractClaims(context: ThreadContext): Promise<Claim[]> {
    // Focus on the most recent post or root post for claim extraction
    const targetPost = context.posts.length > 1
      ? context.posts[context.posts.length - 1]
      : context.rootPost;

    logger.debug('Extracting claims from post', {
      postId: targetPost.id,
      contentLength: targetPost.content.length
    });

    const claims = await this.extractClaimsWithAI(targetPost.content);

    logger.debug('Claims extracted', {
      claimCount: claims.length,
      claims: claims.map(c => c.text.substring(0, 50))
    });

    return claims;
  }

  private async extractClaimsWithAI(text: string): Promise<Claim[]> {
    // Detect and sanitize input
    const detection = this.injectionDetector.detect(text);

    // Use secure prompt template
    const prompt = SecurePrompts.buildClaimExtractionPrompt(detection.sanitized);

    // Use 'factcheck' purpose to get the longer timeout (90s) for reasoning models
    const result = await this.aiService.generateObject<z.infer<typeof ClaimsExtractionSchema>>(
      prompt,
      ClaimsExtractionSchema,
      'factcheck'
    );

    return result.object.claims.map(claim => ({
      text: claim.text,
      confidence: claim.confidence,
      context: claim.context
    }));
  }

  async verify(claims: Claim[]): Promise<FactcheckResult> {
    const startTime = Date.now();
    let searchQueries = 0;
    const allEvidence: Evidence[] = [];
    const verifiedClaims: VerifiedClaim[] = [];

    try {
      // Check if OpenAI is the primary provider
      if (appConfig.ai.primaryProvider !== 'openai') {
        logger.warn('Web search requires OpenAI as primary provider');
        return this.createUnverifiableResult(claims, startTime, 'Web search requires OpenAI provider');
      }

      for (const claim of claims) {
        logger.debug('Verifying claim', {
          claim: claim.text.substring(0, 100),
          confidence: claim.confidence
        });

        try {
          const verificationResult = await this.verifySingleClaim(claim);
          verifiedClaims.push(verificationResult.verifiedClaim);
          allEvidence.push(...verificationResult.evidence);
          searchQueries += verificationResult.searchQueries;

        } catch (error) {
          logger.warn('Failed to verify claim, marking as unverifiable:', error);

          verifiedClaims.push({
            claim: claim.text,
            verdict: 'unverifiable',
            confidence: 0.1,
            evidence: [],
            reasoning: 'Unable to verify due to search error'
          });
        }
      }

      // Calculate overall assessment
      const overallAssessment = this.calculateOverallAssessment(verifiedClaims);

      const result: FactcheckResult = {
        verifiedClaims,
        sources: this.deduplicateAndRankSources(allEvidence),
        overallAssessment,
        metrics: {
          claimsProcessed: claims.length,
          sourcesFound: allEvidence.length,
          searchQueries,
          processingTimeMs: Date.now() - startTime
        }
      };

      logger.debug('Factcheck completed', {
        claimsProcessed: result.metrics.claimsProcessed,
        sourcesFound: result.metrics.sourcesFound,
        overallVerdict: result.overallAssessment.verdict
      });

      return result;

    } catch (error) {
      logger.error('Factcheck verification failed:', error);
      return this.createUnverifiableResult(claims, startTime);
    }
  }

  private async verifySingleClaim(
    claim: Claim
  ): Promise<{
    verifiedClaim: VerifiedClaim;
    evidence: Evidence[];
    searchQueries: number;
  }> {
    // Check cache first
    const cacheKey = this.getCacheKey(claim.text);
    const cachedEvidence = this.getCachedResults(claim.text);

    if (cachedEvidence && cachedEvidence.length > 0) {
      logger.info('Using cached evidence for claim', {
        claim: claim.text.substring(0, 50),
        evidenceCount: cachedEvidence.length
      });

      const verification = this.buildVerificationFromEvidence(claim.text, cachedEvidence);

      return {
        verifiedClaim: verification,
        evidence: cachedEvidence.slice(0, 3),
        searchQueries: 0
      };
    }

    // Detect and sanitize claim text
    const detection = this.injectionDetector.detect(claim.text);

    // Build secure prompt for web search
    const prompt = SecurePrompts.buildFactcheckPrompt(
      detection.sanitized,
      claim.context
    );

    // Generate verification with OpenAI web search
    const result = await this.verifyWithWebSearch(claim, prompt);

    if (!result) {
      return {
        verifiedClaim: {
          claim: claim.text,
          verdict: 'Unable to verify - web search unavailable',
          confidence: 0.1,
          evidence: [],
          reasoning: 'Verification requires web search which could not be performed'
        },
        evidence: [],
        searchQueries: 0
      };
    }

    // Extract evidence from web search results
    const evidence: Evidence[] = [];
    let searchCount = 0;

    if (result.toolResults?.length > 0) {
      for (const toolResult of result.toolResults) {
        // OpenAI uses 'web_search_preview' as the tool name
        if (toolResult.toolName === 'web_search_preview' || toolResult.toolName === 'web_search') {
          searchCount++;
          const extractedEvidence = this.extractEvidenceFromWebSearch(toolResult);
          evidence.push(...extractedEvidence);
        }
      }

      // Cache the extracted evidence
      if (evidence.length > 0) {
        this.setCachedResults(claim.text, evidence);
      }
    }

    // Build narrative from AI response
    let aiText = (result.text || '').trim();
    if (aiText.length < 50 && evidence.length > 0) {
      aiText = this.buildNarrativeFromEvidence(claim.text, evidence);
    }

    // Parse verification response
    const verification = this.parseVerificationResponse(aiText, claim.text, evidence);

    // Ensure verdict is populated
    if (!verification.verdict?.trim()) {
      verification.verdict = verification.reasoning || 'Unable to verify this claim with available evidence';
    }

    return {
      verifiedClaim: verification,
      evidence,
      searchQueries: searchCount
    };
  }

  private async verifyWithWebSearch(
    claim: Claim,
    prompt: string
  ): Promise<any> {
    try {
      // Use OpenAI's web search by passing the web_search tool
      const result = await this.aiService.generateTextWithWebSearch(
        prompt,
        'factcheck'
      );

      // Check if web search was used (OpenAI uses 'web_search_preview')
      const hasWebSearch = result.toolResults?.some(tr =>
        tr.toolName === 'web_search_preview' || tr.toolName === 'web_search'
      );

      if (hasWebSearch) {
        logger.debug('Web search used successfully', {
          claim: claim.text.substring(0, 50),
          toolResults: result.toolResults?.length || 0
        });
        return result;
      }

      logger.warn('Web search not used in verification');
      return result;

    } catch (error: any) {
      logger.error('Web search verification failed:', error);
      throw error;
    }
  }

  private extractEvidenceFromWebSearch(toolResult: any): EnhancedEvidence[] {
    logger.debug('Extracting evidence from web search result', {
      toolResult: toolResult
    });

    const evidence: EnhancedEvidence[] = [];

    // OpenAI web search returns results in a specific format
    // The result should contain search results with urls, titles, and snippets
    const content = toolResult.result || toolResult.content || [];

    if (Array.isArray(content)) {
      for (const item of content.slice(0, 5)) {
        const url = item.url || item.link;
        const title = item.title || item.name;
        const snippet = item.snippet || item.description || item.excerpt || '';

        if (!url || !title) continue;

        const credibility = this.assessSourceReliability(url);

        evidence.push({
          source: this.extractDomain(url),
          title,
          url,
          excerpt: snippet,
          reliability: credibility.score,
          relevance: 0.8,
          credibilityRating: credibility.rating,
          credibilityExplanation: credibility.explanation,
          perspective: credibility.perspective
        });
      }
    }

    logger.debug('Evidence extraction complete', {
      evidenceCount: evidence.length,
      sources: evidence.map(e => e.source)
    });

    return evidence;
  }

  private buildNarrativeFromEvidence(claimText: string, evidence: EnhancedEvidence[]): string {
    if (!evidence || evidence.length === 0) {
      return '';
    }

    const top = evidence.slice(0, 2);
    const parts: string[] = [];
    parts.push(`Found ${evidence.length} relevant sources via web search.`);
    for (const item of top) {
      const excerpt = (item.excerpt || '').replace(/<[^>]+>/g, '').trim();
      const trimmed = excerpt.length > 200 ? excerpt.slice(0, 197) + '...' : excerpt;
      parts.push(`${item.title} (${item.source}) — ${trimmed}`);
    }
    parts.push(`These sources discuss the claim: "${claimText}".`);
    return parts.join(' ');
  }

  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return url;
    }
  }

  private assessSourceReliability(url: string): {
    score: number;
    rating: 'highly reliable' | 'generally reliable' | 'moderate' | 'questionable' | 'unknown';
    explanation: string;
    perspective: string;
  } {
    const domain = this.extractDomain(url);
    const { sources, domainRules, categoryDefaults, config } = this.sourceCredibilityConfig;

    // Check known sources
    if (sources[domain]) {
      const source = sources[domain];
      return {
        score: source.score,
        rating: this.scoreToRating(source.score),
        explanation: source.notes || `${source.tier} tier ${source.category} source`,
        perspective: source.perspective || source.category
      };
    }

    // Check domain suffix rules
    const suffix = Object.keys(domainRules).find(s => domain.endsWith(s));
    if (suffix) {
      const rule = domainRules[suffix];
      return {
        score: rule.score,
        rating: this.scoreToRating(rule.score),
        explanation: rule.notes || rule.reason,
        perspective: rule.reason
      };
    }

    // Infer category from domain patterns
    const category = this.inferSourceCategory(domain);
    const score = categoryDefaults[category] || config.defaultScore;

    return {
      score,
      rating: this.scoreToRating(score),
      explanation: `Unverified ${category} source`,
      perspective: category
    };
  }

  private inferSourceCategory(domain: string): string {
    const patterns = {
      news: ['news', 'times', 'post', 'daily', 'tribune', 'herald'],
      scientific: ['journal', 'research', 'academic', 'science', 'scholar'],
      health: ['health', 'medical', 'clinic', 'hospital', 'pharma'],
      business: ['business', 'finance', 'market', 'trade', 'commerce'],
      tech: ['tech', 'code', 'dev', 'digital', 'cyber']
    };

    for (const [category, keywords] of Object.entries(patterns)) {
      if (keywords.some(keyword => domain.includes(keyword))) {
        return category;
      }
    }

    return 'unknown';
  }

  private scoreToRating(score: number): 'highly reliable' | 'generally reliable' | 'moderate' | 'questionable' | 'unknown' {
    if (score >= 0.9) return 'highly reliable';
    if (score >= 0.75) return 'generally reliable';
    if (score >= 0.5) return 'moderate';
    if (score >= 0.25) return 'questionable';
    return 'unknown';
  }

  private parseVerificationResponse(
    aiResponse: string,
    claim: string,
    evidence: EnhancedEvidence[]
  ): VerifiedClaim {
    logger.debug('Parsing verification response', {
      responseLength: aiResponse.length,
      responsePreview: aiResponse.substring(0, 200)
    });

    let narrative = aiResponse.trim();

    // Remove meta-commentary
    narrative = narrative
      .replace(/^I searched for.*?\. /i, '')
      .replace(/^I found.*?\. /i, '')
      .replace(/^Based on my search.*?\. /i, '')
      .replace(/^After searching.*?\. /i, '')
      .trim();

    if (narrative.length < 50) {
      narrative = 'Unable to verify this claim with the available search results.';
      logger.warn('Response too short, using fallback', {
        originalLength: aiResponse.length
      });
    }

    // Extract confidence from natural language
    let confidenceScore = 0.5;
    const perspectives: string[] = [];

    const lowerResponse = aiResponse.toLowerCase();
    if (lowerResponse.includes('strongly confirm') || lowerResponse.includes('definitively') ||
        lowerResponse.includes('clearly shows') || lowerResponse.includes('conclusive')) {
      confidenceScore = 0.8;
    } else if (lowerResponse.includes('appears to') || lowerResponse.includes('suggests') ||
               lowerResponse.includes('likely') || lowerResponse.includes('seems')) {
      confidenceScore = 0.5;
    } else if (lowerResponse.includes('limited evidence') || lowerResponse.includes('unclear') ||
               lowerResponse.includes('disputed') || lowerResponse.includes('conflicting')) {
      confidenceScore = 0.3;
    }

    // Look for alternative viewpoints
    if (lowerResponse.includes('however') || lowerResponse.includes('on the other hand') ||
        lowerResponse.includes('alternatively') || lowerResponse.includes('critics argue')) {
      const contrastMatch = aiResponse.match(/(?:however|on the other hand|alternatively|critics argue)[\s,]+(.+?)(?:\.|$)/i);
      if (contrastMatch) {
        perspectives.push(contrastMatch[1].trim());
      }
    }

    // Adjust based on evidence quality
    if (evidence.length >= 3) {
      const avgReliability = evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length;
      confidenceScore = (confidenceScore * 0.6) + (avgReliability * 0.4);
    } else if (evidence.length === 0) {
      confidenceScore = Math.min(confidenceScore, 0.3);
    }

    return {
      claim,
      verdict: narrative,
      confidence: Math.min(Math.max(confidenceScore, 0.1), 1.0),
      evidence: evidence.slice(0, 3),
      reasoning: narrative,
      alternativePerspectives: perspectives.length > 0 ? perspectives : undefined
    };
  }

  private calculateOverallAssessment(verifiedClaims: VerifiedClaim[]): {
    narrative: string;
    verdict?: string;
    confidence: number;
    reasoning: string;
  } {
    if (verifiedClaims.length === 0) {
      return {
        narrative: "I couldn't process any verifiable claims from this content.",
        verdict: "I couldn't process any verifiable claims from this content.",
        confidence: 0.1,
        reasoning: 'No claims could be processed'
      };
    }

    const avgConfidence = verifiedClaims.reduce((sum, claim) => sum + claim.confidence, 0) / verifiedClaims.length;

    let narrative = '';

    if (verifiedClaims.length === 1) {
      narrative = verifiedClaims[0].reasoning;
    } else {
      const mostConfident = [...verifiedClaims].sort((a, b) => b.confidence - a.confidence)[0];
      narrative = mostConfident.reasoning;

      const otherHighConfidence = verifiedClaims
        .filter(c => c !== mostConfident && c.confidence > 0.5)
        .slice(0, 1);

      if (otherHighConfidence.length > 0) {
        const additionalContext = otherHighConfidence[0].reasoning.split(/[.!?]/)[0];
        if (additionalContext && !narrative.includes(additionalContext)) {
          narrative += ' Additionally, ' + additionalContext.toLowerCase() + '.';
        }
      }
    }

    return {
      narrative,
      verdict: narrative,
      confidence: avgConfidence,
      reasoning: narrative
    };
  }

  private deduplicateAndRankSources(evidence: EnhancedEvidence[]): EnhancedEvidence[] {
    const uniqueSources = new Map<string, EnhancedEvidence>();

    for (const source of evidence) {
      const key = source.url;
      if (!uniqueSources.has(key) || source.reliability > uniqueSources.get(key)!.reliability) {
        uniqueSources.set(key, source);
      }
    }

    return Array.from(uniqueSources.values())
      .sort((a, b) => (b.reliability * b.relevance) - (a.reliability * a.relevance))
      .slice(0, 5);
  }

  private createUnverifiableResult(claims: Claim[], startTime: number, reason?: string): FactcheckResult {
    const narrativeMessage = reason || "I wasn't able to verify this claim because the web search service is currently unavailable. Please try again later.";

    return {
      verifiedClaims: claims.map(claim => ({
        claim: claim.text,
        verdict: narrativeMessage,
        confidence: 0.1,
        evidence: [],
        reasoning: narrativeMessage
      })),
      sources: [],
      overallAssessment: {
        narrative: narrativeMessage,
        verdict: narrativeMessage,
        confidence: 0.1,
        reasoning: 'Verification service unavailable'
      },
      metrics: {
        claimsProcessed: claims.length,
        sourcesFound: 0,
        searchQueries: 0,
        processingTimeMs: Date.now() - startTime
      }
    };
  }

  private buildVerificationFromEvidence(claimText: string, evidence: EnhancedEvidence[]): VerifiedClaim {
    const avgReliability = evidence.length > 0
      ? evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length
      : 0.5;

    let verdict = '';
    let confidence = avgReliability;
    let reasoning = '';

    if (evidence.length === 0) {
      verdict = 'unverifiable';
      confidence = 0.1;
      reasoning = 'No cached evidence available for this claim';
    } else if (avgReliability >= 0.8) {
      verdict = 'Supported by highly reliable sources';
      reasoning = `Found ${evidence.length} cached sources with high credibility (${evidence.map(e => e.source).slice(0, 3).join(', ')})`;
    } else if (avgReliability >= 0.6) {
      verdict = 'Supported by generally reliable sources';
      reasoning = `Found ${evidence.length} cached sources with moderate to good credibility`;
    } else {
      verdict = 'Supported by sources with mixed reliability';
      confidence = Math.max(0.3, avgReliability);
      reasoning = `Found ${evidence.length} cached sources but reliability varies`;
    }

    const narrative = `Based on previously cached search results: ${reasoning}. The claim "${claimText}" appears to be ${verdict.toLowerCase()}.`;

    return {
      claim: claimText,
      verdict: narrative,
      confidence,
      evidence: evidence.slice(0, 3),
      reasoning,
      alternativePerspectives: evidence.length > 1
        ? [`Multiple sources were found with varying perspectives from: ${evidence.map(e => e.perspective || 'unknown').filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(', ')}`]
        : undefined
    };
  }
}
