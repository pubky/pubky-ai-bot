import { AIService } from './ai';
import { McpClientService } from './mcp/client';
import { ThreadContext } from '@/types/thread';
// Note: stepCountIs may need to be imported differently based on AI SDK version
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
  reliability: number; // 0-1 scale
  relevance: number;   // 0-1 scale
}

export interface EnhancedEvidence extends Evidence {
  credibilityRating?: 'highly reliable' | 'generally reliable' | 'moderate' | 'questionable' | 'unknown';
  credibilityExplanation?: string; // e.g., "Reuters is a well-established news agency..."
  perspective?: string; // e.g., "mainstream media", "government source", "academic"
}

export interface VerifiedClaim {
  claim: string;
  verdict: string; // Changed from enum to free-form narrative string
  confidence: number;
  evidence: EnhancedEvidence[]; // Changed from Evidence[] to EnhancedEvidence[]
  reasoning: string;
  alternativePerspectives?: string[]; // NEW: capture different viewpoints
}

export interface FactcheckResult {
  verifiedClaims: VerifiedClaim[];
  sources: EnhancedEvidence[]; // Changed from Evidence[] to EnhancedEvidence[]
  overallAssessment: {
    narrative: string; // NEW: conversational summary
    verdict?: string; // Optional, more flexible (can be narrative or category)
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

// Zod schema for Brave search result item
const BraveSearchResultSchema = z.object({
  url: z.string().optional(),
  link: z.string().optional(),
  href: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  snippet: z.string().optional(),
  description: z.string().optional(),
  excerpt: z.string().optional(),
  age: z.string().optional(),
  date: z.string().optional()
}).refine(data => (data.url || data.link || data.href) && (data.title || data.name), {
  message: "Search result must have a URL field and a title field"
});

// Zod schema for MCP tool result variations
const McpToolResultSchema = z.union([
  // Format 1: Direct array of results
  z.array(BraveSearchResultSchema),
  // Format 2: Object with result field
  z.object({
    result: z.union([
      z.array(BraveSearchResultSchema),
      BraveSearchResultSchema
    ])
  }),
  // Format 3: Object with content field (can be JSON string)
  z.object({
    content: z.union([
      z.array(BraveSearchResultSchema),
      z.string() // JSON string that needs parsing
    ])
  })
]);

// Zod schema for MCP tool call result
const McpToolCallResultSchema = z.object({
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  result: McpToolResultSchema.optional(),
  content: z.any().optional(),
  error: z.string().optional()
});

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

// Zod schema for Grok-style narrative verification output
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

export class FactcheckService {
  private sourceCredibilityConfig: any;
  private searchCache: Map<string, CachedSearchResult>;
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  constructor(
    private aiService: AIService,
    private mcpClient: McpClientService
  ) {
    // Load source credibility configuration
    this.loadSourceCredibilityConfig();

    // Initialize search cache
    this.searchCache = new Map();

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
    const prompt = `Extract ONLY verifiable factual claims from the following text.

A factual claim is a statement that can be verified as true or false through evidence, data, or reliable sources.

INCLUDE claims that:
- State specific facts, statistics, or data points
- Make assertions about events, people, or organizations
- Describe scientific or medical findings
- Report on actions, policies, or statements by public figures
- Make comparisons that can be fact-checked

EXCLUDE:
- Opinions, beliefs, or subjective statements (e.g., "I think", "I believe")
- Predictions or future speculations (e.g., "might", "could", "will probably")
- Value judgments (e.g., "best", "worst", "should")
- Vague or unverifiable statements
- Questions or hypotheticals
- Personal experiences or anecdotes

Text to analyze:
"${text}"

Return a JSON object with an array of claims. For each claim, provide:
- text: The exact factual claim (preserve original wording when possible)
- confidence: Score from 0-1 indicating how clearly this is a verifiable factual claim
- context: Any important context needed to understand the claim (optional)

Focus on the most significant and checkable claims. Ignore trivial or obvious facts.`;

    const result = await this.aiService.generateObject<z.infer<typeof ClaimsExtractionSchema>>(
      prompt,
      ClaimsExtractionSchema,
      'classifier'
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
      if (!this.mcpClient.isReady()) {
        logger.warn('MCP client not ready, returning unverifiable result');
        return this.createUnverifiableResult(claims, startTime);
      }

      // Get MCP tools for search - filter to reduce token usage
      const allTools = await this.mcpClient.tools();

      logger.info('MCP tools available', {
        toolCount: Object.keys(allTools).length,
        toolNames: Object.keys(allTools).slice(0, 3) // Log first 3 tool names
      });

      // Only use essential search tool to minimize token usage
      // This helps with both Groq's limits and improves OpenAI performance
      const tools = allTools.brave_web_search
        ? { brave_web_search: allTools.brave_web_search }
        : allTools; // Fallback to all tools if brave_web_search not found

      logger.info('Using filtered tools for factcheck', {
        filteredToolCount: Object.keys(tools).length,
        provider: appConfig.ai.primaryProvider
      });

      for (const claim of claims) {
        logger.debug('Verifying claim', {
          claim: claim.text.substring(0, 100),
          confidence: claim.confidence
        });

        try {
          const verificationResult = await this.verifySingleClaim(claim, tools);
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

  private async verifySingleClaimStructured(
    claim: Claim,
    tools: Record<string, any>
  ): Promise<{
    verifiedClaim: VerifiedClaim;
    evidence: Evidence[];
    searchQueries: number;
  }> {
    // Create search queries for the claim
    let searchCount = 0;
    const evidence: Evidence[] = [];

    // Build Grok-style verification prompt for structured output
    const prompt = `You are a witty, insightful fact-checker. Verify this claim by searching for evidence and explaining what you find in a conversational way - like talking to a friend.

CLAIM: "${claim.text}"

Search for reliable sources, consider multiple perspectives, and synthesize what you find into a clear, nuanced explanation. Be conversational and engaging, not robotic. Acknowledge complexity and alternative viewpoints when they exist.`;

    try {
      // Use AI with MCP tools to verify the claim and get structured output
      const result = await this.aiService.generateObject<z.infer<typeof NarrativeVerificationSchema>>(
        prompt,
        NarrativeVerificationSchema,
        'factcheck'
      );

      // Log the structured result
      logger.debug('Structured verification result', {
        narrativeLength: result.object.narrativeSummary.length,
        confidence: result.object.confidence,
        hasAlternatives: result.object.alternativePerspectives ? result.object.alternativePerspectives.length : 0
      });

      // Map confidence from enum to number
      const confidenceMap = {
        'high': 0.8,
        'medium': 0.5,
        'low': 0.3
      };

      const verification: VerifiedClaim = {
        claim: claim.text,
        verdict: result.object.narrativeSummary, // Use narrative as verdict
        confidence: confidenceMap[result.object.confidence],
        evidence: evidence.slice(0, 3),
        reasoning: result.object.narrativeSummary, // Also store in reasoning
        alternativePerspectives: result.object.alternativePerspectives
      };

      return {
        verifiedClaim: verification,
        evidence,
        searchQueries: searchCount
      };

    } catch (error) {
      logger.error('Error in structured claim verification:', error);

      // Fall back to the original text-based method
      return this.verifySingleClaim(claim, tools);
    }
  }

  private async verifySingleClaim(
    claim: Claim,
    tools: Record<string, any>
  ): Promise<{
    verifiedClaim: VerifiedClaim;
    evidence: Evidence[];
    searchQueries: number;
  }> {
    // Check cache first for similar claims
    const cacheKey = this.getCacheKey(claim.text);
    const cachedEvidence = this.getCachedResults(claim.text);

    if (cachedEvidence && cachedEvidence.length > 0) {
      // Use cached evidence to generate a quick verification
      logger.info('Using cached evidence for claim', {
        claim: claim.text.substring(0, 50),
        evidenceCount: cachedEvidence.length
      });

      // Build a verification based on cached evidence
      const verification = this.buildVerificationFromEvidence(claim.text, cachedEvidence);

      return {
        verifiedClaim: verification,
        evidence: cachedEvidence.slice(0, 3), // Return top 3 evidence items
        searchQueries: 0 // No new queries were made
      };
    }

    // Initialize evidence tracking
    const evidence: Evidence[] = [];

    // Build concise verification prompt
    const prompt = `Verify this claim by searching for evidence: "${claim.text}"

REQUIRED: Use the brave_web_search tool to find evidence before responding.

After searching, provide:

NARRATIVE SUMMARY:
2-3 conversational sentences explaining what you found. Include source quality (e.g., "Reuters reports..." or "peer-reviewed studies show...") and any important nuances.

CONFIDENCE: high/medium/low with brief reason

ALTERNATIVE PERSPECTIVES:
(If relevant) Note any legitimate alternative viewpoints

Be conversational and balanced - explain what you found, not just true/false.`;

    // Generate verification with required tool usage
    const result = await this.verifyWithRetry(claim, tools, prompt);

    if (!result) {
      return {
        verifiedClaim: {
          claim: claim.text,
          verdict: 'Unable to verify - search tools unavailable',
          confidence: 0.1,
          evidence: [],
          reasoning: 'Verification requires search evidence which could not be obtained'
        },
        evidence: [],
        searchQueries: 0
      };
    }

    // Extract evidence from tool results
    let searchCount = 0;
    if (result.toolResults?.length > 0) {
      for (const toolResult of result.toolResults) {
        searchCount++;
        const extractedEvidence = this.extractEvidenceFromSearch(toolResult);
        evidence.push(...extractedEvidence);
      }

      // Cache the extracted evidence
      if (evidence.length > 0) {
        this.setCachedResults(claim.text, evidence);
      }
    }

    // Parse AI response for verdict
    const verification = this.parseVerificationResponse(result.text, claim.text, evidence);

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

  private async verifyWithRetry(
    claim: Claim,
    tools: Record<string, any>,
    prompt: string,
    maxRetries: number = 2 // Reduced retries since prompt is clearer
  ): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const enhancedPrompt = attempt > 1
          ? `${prompt}\n\nCRITICAL: You MUST use brave_web_search before responding. This is attempt ${attempt} of ${maxRetries}.`
          : prompt;

        const result = await this.aiService.generateText(
          enhancedPrompt,
          'factcheck',
          { tools, maxRetries: 1 }
        );

        // Check if tools were actually used
        const hasToolUsage = result.toolResults?.length > 0 ||
                             (result.text?.includes('searched') && result.text?.includes('found'));

        if (hasToolUsage && result.text?.trim()) {
          logger.debug('Successful tool usage on attempt', { attempt, claim: claim.text.substring(0, 50) });
          return result;
        }

        if (attempt < maxRetries) {
          logger.warn(`Retry ${attempt}/${maxRetries}: No tool usage detected`);
        }
      } catch (error: any) {
        // Handle specific provider errors
        if (error.message?.includes('token') && attempt === 1) {
          logger.warn('Token limit issue detected, will retry with shorter claim');
          // Truncate claim for retry if it's too long
          claim.text = claim.text.substring(0, 100) + '...';
        } else if (attempt === maxRetries) {
          throw error; // Re-throw on final attempt
        }
      }
    }

    logger.error('Failed to get tool usage after all retries', { claim: claim.text });
    return null;
  }

  private generateSearchQueries(claim: string): string[] {
    // Extract key terms for search variation
    const stopWords = new Set(['this', 'that', 'they', 'have', 'been', 'will', 'said', 'the', 'is', 'are', 'was', 'were']);
    const keyWords = claim
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w.toLowerCase()));

    // Return original claim and a simplified version if possible
    return keyWords.length > 3
      ? [claim, keyWords.slice(0, 5).join(' ')]
      : [claim];
  }

  private extractEvidenceFromSearch(toolResult: any): EnhancedEvidence[] {
    // Handle string content that needs JSON parsing
    let processedResult = toolResult;
    if (toolResult?.content && typeof toolResult.content === 'string') {
      try {
        processedResult = { ...toolResult, content: JSON.parse(toolResult.content) };
      } catch {
        logger.error('Failed to parse MCP content as JSON');
        return [];
      }
    }

    // Validate with Zod schema - no fallback
    let searchResults: any[] = [];
    try {
      const validated = McpToolResultSchema.parse(processedResult);

      // Extract search results based on validated format
      if (Array.isArray(validated)) {
        searchResults = validated;
      } else if ('result' in validated) {
        searchResults = Array.isArray(validated.result) ? validated.result : [validated.result];
      } else if ('content' in validated) {
        searchResults = Array.isArray(validated.content) ? validated.content : [validated.content];
      }
    } catch (zodError) {
      logger.error('Invalid MCP response format', zodError);
      return [];
    }

    logger.debug('Extracted search results', { count: searchResults.length });

    // Convert search results to evidence
    const evidence: EnhancedEvidence[] = [];

    for (const result of searchResults.slice(0, 5)) { // Process top 5
      const url = result.url || result.link || result.href;
      const title = result.title || result.name;
      const snippet = result.snippet || result.description || result.excerpt || '';

      if (!url || !title) continue;

      const credibility = this.assessSourceReliability(url);

      evidence.push({
        source: this.extractDomain(url),
        title,
        url,
        excerpt: snippet,
        reliability: credibility.score,
        relevance: 0.8, // Default relevance
        credibilityRating: credibility.rating,
        credibilityExplanation: credibility.explanation,
        perspective: credibility.perspective
      });
    }

    logger.debug('Evidence extraction complete', {
      evidenceCount: evidence.length,
      sources: evidence.map(e => e.source)
    });

    return evidence;
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

    // Extract narrative summary (primary approach for Grok-style responses)
    let narrative = '';
    const narrativeMatch = aiResponse.match(/NARRATIVE SUMMARY:\s*(.+?)(?=\n\n|CONFIDENCE:|ALTERNATIVE PERSPECTIVES:|$)/is);
    if (narrativeMatch) {
      narrative = narrativeMatch[1].trim();
      logger.debug('Narrative summary extracted', { length: narrative.length });
    } else {
      // Fallback 1: Look for any substantial paragraph after the claim
      const paragraphs = aiResponse.split('\n\n').map(p => p.trim()).filter(p => p.length > 100);
      narrative = paragraphs.find(p =>
        !p.includes('CLAIM') &&
        !p.includes('INSTRUCTIONS') &&
        !p.includes('YOUR APPROACH')
      ) || '';

      if (narrative) {
        logger.debug('Narrative extracted from paragraph', { length: narrative.length });
      } else {
        // Fallback 2: Use entire response minus headers
        narrative = aiResponse
          .replace(/NARRATIVE SUMMARY:|CONFIDENCE:|ALTERNATIVE PERSPECTIVES:/g, '')
          .split('\n\n')
          .find(p => p.length > 50) || 'Unable to extract verification summary from LLM response';

        logger.warn('Could not extract clear narrative, using fallback', {
          response: aiResponse.substring(0, 300)
        });
      }
    }

    // Extract alternative perspectives if present
    const perspectives: string[] = [];
    const perspectivesMatch = aiResponse.match(/ALTERNATIVE PERSPECTIVES:\s*(.+?)(?=\n\n|$)/is);
    if (perspectivesMatch) {
      const perspectiveText = perspectivesMatch[1].trim();
      // Parse bullet points or numbered lists
      const items = perspectiveText
        .split(/\n[-•*]|\n\d+\./)
        .map(s => s.trim())
        .filter(s => s.length > 10 && !s.startsWith('['));
      perspectives.push(...items);
      logger.debug('Alternative perspectives extracted', { count: perspectives.length });
    }

    // Calculate confidence based on evidence quality and LLM confidence
    let confidenceScore = 0.5; // Default medium

    // Check if LLM expressed confidence
    const confidenceMatch = aiResponse.match(/CONFIDENCE:\s*(high|medium|low)(.+)?/i);
    if (confidenceMatch) {
      const llmConfidence = confidenceMatch[1].toLowerCase();
      if (llmConfidence === 'high') confidenceScore = 0.8;
      else if (llmConfidence === 'medium') confidenceScore = 0.5;
      else if (llmConfidence === 'low') confidenceScore = 0.3;
      logger.debug('Confidence extracted', { level: llmConfidence, reason: confidenceMatch[2]?.trim() });
    }

    // Adjust based on evidence quality if available
    if (evidence.length >= 3) {
      const avgReliability = evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length;
      // Weighted average: LLM confidence (60%) + evidence reliability (40%)
      confidenceScore = (confidenceScore * 0.6) + (avgReliability * 0.4);
    } else if (evidence.length === 0) {
      confidenceScore = Math.min(confidenceScore, 0.3); // Cap at low if no evidence
    }

    return {
      claim,
      verdict: narrative, // Use narrative as the verdict
      confidence: Math.min(Math.max(confidenceScore, 0.1), 1.0), // Clamp between 0.1 and 1.0
      evidence: evidence.slice(0, 3), // Top 3 pieces of evidence
      reasoning: narrative, // Also store in reasoning for compatibility
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

    // Calculate average confidence
    const avgConfidence = verifiedClaims.reduce((sum, claim) => sum + claim.confidence, 0) / verifiedClaims.length;

    // Build conversational narrative from individual claim narratives
    let narrative = '';

    if (verifiedClaims.length === 1) {
      // Single claim: use its full narrative
      narrative = verifiedClaims[0].reasoning;
    } else {
      // Multiple claims: create a synthesized narrative
      narrative = `I verified ${verifiedClaims.length} claims here. `;

      // Add snippet from most confident claim
      const mostConfident = [...verifiedClaims].sort((a, b) => b.confidence - a.confidence)[0];
      const firstSentence = mostConfident.reasoning.split(/[.!?]/)[0];
      if (firstSentence) {
        narrative += firstSentence + '. ';
      }

      // Add confidence context
      const confidenceLevel = avgConfidence > 0.7 ? 'High' : avgConfidence > 0.4 ? 'Moderate' : 'Limited';
      const totalEvidence = verifiedClaims.reduce((sum, c) => sum + c.evidence.length, 0);
      narrative += `${confidenceLevel} confidence overall, based on ${totalEvidence} sources across multiple searches.`;
    }

    return {
      narrative,
      verdict: narrative, // Also set verdict for compatibility
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
      .slice(0, 5); // Top 5 sources
  }

  private createUnverifiableResult(claims: Claim[], startTime: number): FactcheckResult {
    const narrativeMessage = "I wasn't able to verify this claim because the search service is currently unavailable. Please try again later.";

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
    // Build a verification based solely on cached evidence without making new API calls
    const avgReliability = evidence.length > 0
      ? evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length
      : 0.5;

    // Determine verdict based on evidence reliability
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

    // Build narrative from cached evidence
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