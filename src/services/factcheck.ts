import { AIService } from './ai';
import { McpClientService } from './mcp/client';
import { ThreadContext } from '@/types/thread';
import { SecurePrompts } from './secure-prompts';
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
  date: z.string().optional(),
  // Additional fields that might come from different MCP providers
  summary: z.string().optional(),
  text: z.string().optional(),
  content: z.string().optional(),
  source: z.string().optional(),
  published: z.string().optional(),
  publishedDate: z.string().optional()
}).passthrough() // Allow additional fields
.refine(data => (data.url || data.link || data.href) && (data.title || data.name), {
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
  }),
  // Format 4: Object with data field
  z.object({
    data: z.union([
      z.array(BraveSearchResultSchema),
      BraveSearchResultSchema
    ])
  }),
  // Format 5: Object with results field
  z.object({
    results: z.union([
      z.array(BraveSearchResultSchema),
      BraveSearchResultSchema
    ])
  }),
  // Format 6: Object with items field
  z.object({
    items: z.union([
      z.array(BraveSearchResultSchema),
      BraveSearchResultSchema
    ])
  }),
  // Format 7: Object with search_results field
  z.object({
    search_results: z.union([
      z.array(BraveSearchResultSchema),
      BraveSearchResultSchema
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

// Zod schema for narrative verification output
const NarrativeVerificationSchema = z.object({
  narrativeSummary: z.string()
    .describe('2-4 sentence explanation of findings based on evidence from reliable sources')
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
    // Strategy:
    // - If the mention post has a parent: fact-check the entire thread (parent + ancestors)
    // - If the mention post has no parent: fact-check just that post's content (excluding bot mention)

    const mentionPost = context.posts[context.posts.length - 1]; // Most recent post is the mention

    let contentToAnalyze: string;

    if (mentionPost.parentUri) {
      // Mention is a reply - analyze the entire thread
      // Combine all posts in chronological order for context
      const threadContent = context.posts
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map(post => post.content)
        .join('\n\n');

      contentToAnalyze = threadContent;

      logger.debug('Extracting claims from thread (mention has parent)', {
        postCount: context.posts.length,
        contentLength: contentToAnalyze.length
      });
    } else {
      // Mention is a top-level post - analyze just the content, removing bot mention
      // The mention contains the bot's public key (pk:xxxxx format)
      contentToAnalyze = mentionPost.content
        .replace(/pk:[a-z0-9]+/gi, '')  // Remove bot's public key
        .replace(/@[a-z0-9-]+/gi, '')   // Remove any @mentions
        .trim();

      logger.debug('Extracting claims from direct mention (no parent)', {
        originalLength: mentionPost.content.length,
        cleanedLength: contentToAnalyze.length
      });
    }

    const claims = await this.extractClaimsWithAI(contentToAnalyze);

    logger.debug('Claims extracted', {
      claimCount: claims.length,
      claims: claims.map(c => c.text.substring(0, 50))
    });

    return claims;
  }

  private async extractClaimsWithAI(text: string): Promise<Claim[]> {
    const prompt = SecurePrompts.buildClaimExtractionPrompt(text);

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

    // Build secure factcheck prompt
    const prompt = SecurePrompts.buildFactcheckPrompt(claim.text, claim.context);

    try {
      // Use AI with MCP tools to verify the claim and get structured output
      const result = await this.aiService.generateObject<z.infer<typeof NarrativeVerificationSchema>>(
        prompt,
        NarrativeVerificationSchema,
        'factcheck'
      );

      // Log the structured result
      logger.debug('Structured verification result', {
        narrativeLength: result.object.narrativeSummary.length
      });

      const verification: VerifiedClaim = {
        claim: claim.text,
        verdict: result.object.narrativeSummary, // Use narrative as verdict
        confidence: 0.5, // Default confidence
        evidence: evidence.slice(0, 3),
        reasoning: result.object.narrativeSummary // Also store in reasoning
      };

      return {
        verifiedClaim: verification,
        evidence,
        searchQueries: searchCount
      };

    } catch (error) {
      logger.error('Error in structured claim verification:', error);

      // Return a low-confidence result instead of failing completely
      const fallbackVerification: VerifiedClaim = {
        claim: claim.text,
        verdict: `I wasn't able to fully verify this claim due to technical limitations, but I'll continue checking other aspects of the content.`,
        confidence: 0.2,
        evidence: evidence.slice(0, 3),
        reasoning: `Unable to complete verification due to technical issues.`,
        alternativePerspectives: []
      };

      return {
        verifiedClaim: fallbackVerification,
        evidence,
        searchQueries: searchCount
      };
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

    // Build secure factcheck prompt
    const prompt = SecurePrompts.buildFactcheckPrompt(claim.text, claim.context);

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

    // Build narrative: prefer AI response, fall back to evidence-based narrative if too short
    let aiText = (result.text || '').trim();
    if (aiText.length < 50 && evidence.length > 0) {
      const rebuilt = this.buildNarrativeFromEvidence(claim.text, evidence);
      if (rebuilt.trim().length > 0) {
        aiText = rebuilt;
      }
    }

    // Parse final narrative for verdict
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
        const toolCallsCount = (result as any).toolCalls?.length || 0;
        const toolResultsCount = result.toolResults?.length || 0;
        const hasToolUsage = toolResultsCount > 0 ||
                             toolCallsCount > 0 ||
                             (result.text?.includes('searched') && result.text?.includes('found'));

        if (hasToolUsage) {
          logger.debug('Successful tool usage on attempt', {
            attempt,
            claim: claim.text.substring(0, 50),
            toolCalls: toolCallsCount,
            toolResults: toolResultsCount
          });
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
    // Log the raw tool result for debugging
    logger.debug('Raw MCP tool result', {
      toolResult,
      keys: toolResult ? Object.keys(toolResult) : [],
      type: typeof toolResult
    });

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

    // Extract search results with flexible field detection (primary approach)
    let searchResults: any[] = [];

    // Try common field patterns first (most reliable)
    if (processedResult && typeof processedResult === 'object') {
      // Check for array at root level
      if (Array.isArray(processedResult)) {
        searchResults = processedResult;
      } else {
        // Check for common field names that contain results
        const possibleFields = ['result', 'content', 'data', 'results', 'items', 'search_results', 'output', 'response'];
        for (const field of possibleFields) {
          if (processedResult[field]) {
            const fieldData = processedResult[field];
            if (Array.isArray(fieldData)) {
              searchResults = fieldData;
              break;
            } else if (typeof fieldData === 'object') {
              searchResults = [fieldData];
              break;
            }
          }
        }

        // Special handling for Brave MCP shape: output.content[] as text JSON items
        if (searchResults.length === 0 && processedResult.output && typeof processedResult.output === 'object') {
          const out = processedResult.output;
          const content = Array.isArray(out.content) ? out.content : [];
          const parsed: any[] = [];
          for (const item of content) {
            const text = item?.text;
            if (typeof text === 'string') {
              try {
                const obj = JSON.parse(text);
                if (Array.isArray(obj)) {
                  parsed.push(...obj);
                } else if (obj && typeof obj === 'object') {
                  parsed.push(obj);
                }
              } catch {
                // ignore non-JSON text entries
              }
            }
          }
          if (parsed.length > 0) {
            searchResults = parsed;
          }
        }

        // If still no results, try to use the object itself if it has URL/title-like fields
        if (searchResults.length === 0) {
          if ((processedResult.url || processedResult.link || processedResult.href) &&
              (processedResult.title || processedResult.name)) {
            searchResults = [processedResult];
          }
        }
      }
    }

    // Optionally validate with Zod schema for better type safety (but don't fail on errors)
    if (searchResults.length > 0) {
      try {
        const validated = McpToolResultSchema.parse(processedResult);
        logger.debug('MCP response validated successfully');
      } catch (zodError) {
        // Log at debug level since we have a working fallback
        logger.debug('MCP response format differs from schema, using flexible extraction', {
          keys: processedResult ? Object.keys(processedResult) : [],
          resultsFound: searchResults.length
        });
      }
    }

    if (searchResults.length === 0) {
      logger.debug('No search results extracted from MCP response');
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

    // Since we're asking for direct findings without headers, use the entire response as the narrative
    let narrative = aiResponse.trim();

    // Remove any accidental meta-commentary if it slipped through
    narrative = narrative
      .replace(/^I searched for.*?\. /i, '')
      .replace(/^I found.*?\. /i, '')
      .replace(/^Based on my search.*?\. /i, '')
      .replace(/^After searching.*?\. /i, '')
      .trim();

    // If the response is empty or too short, use a fallback
    if (narrative.length < 50) {
      narrative = 'Unable to verify this claim with the available search results.';
      logger.warn('Response too short, using fallback', {
        originalLength: aiResponse.length,
        response: aiResponse.substring(0, 300)
      });
    } else {
      logger.debug('Using direct response as narrative', { length: narrative.length });
    }

    // Use default confidence based on evidence quality
    let confidenceScore = 0.5; // Default medium

    // Adjust based on evidence quality if available
    if (evidence.length >= 3) {
      const avgReliability = evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length;
      confidenceScore = avgReliability;
    } else if (evidence.length === 0) {
      confidenceScore = 0.3; // Lower confidence if no evidence
    }

    return {
      claim,
      verdict: narrative, // Use narrative as the verdict
      confidence: Math.min(Math.max(confidenceScore, 0.1), 1.0), // Clamp between 0.1 and 1.0
      evidence: evidence.slice(0, 3), // Top 3 pieces of evidence
      reasoning: narrative // Also store in reasoning for compatibility
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
      // Multiple claims: synthesize narratives naturally
      // Start with the most confident claim's full reasoning
      const mostConfident = [...verifiedClaims].sort((a, b) => b.confidence - a.confidence)[0];
      narrative = mostConfident.reasoning;

      // Add additional context from other high-confidence claims if they add value
      const otherHighConfidence = verifiedClaims
        .filter(c => c !== mostConfident && c.confidence > 0.5)
        .slice(0, 1); // Take at most one additional high-confidence claim

      if (otherHighConfidence.length > 0) {
        // Extract a key sentence from the additional claim
        const additionalContext = otherHighConfidence[0].reasoning.split(/[.!?]/)[0];
        if (additionalContext && !narrative.includes(additionalContext)) {
          narrative += ' Additionally, ' + additionalContext.toLowerCase() + '.';
        }
      }
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
      reasoning
    };
  }
}
