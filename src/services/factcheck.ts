import { AIService } from './ai';
import { McpClientService } from './mcp/client';
import { ThreadContext } from '@/types/thread';
// Note: stepCountIs may need to be imported differently based on AI SDK version
import logger from '@/utils/logger';
import appConfig from '@/config';

export interface Claim {
  text: string;
  confidence: number;
  context?: string;
}

export interface VerifiedClaim {
  claim: string;
  verdict: 'accurate' | 'mostly accurate' | 'mixed' | 'mostly inaccurate' | 'inaccurate' | 'unverifiable';
  confidence: number;
  evidence: Evidence[];
  reasoning: string;
}

export interface Evidence {
  source: string;
  title: string;
  url: string;
  excerpt?: string;
  reliability: number; // 0-1 scale
  relevance: number;   // 0-1 scale
}

export interface FactcheckResult {
  verifiedClaims: VerifiedClaim[];
  sources: Evidence[];
  overallAssessment: {
    verdict: 'accurate' | 'mostly accurate' | 'mixed' | 'mostly inaccurate' | 'inaccurate' | 'unverifiable';
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

export class FactcheckService {
  constructor(
    private aiService: AIService,
    private mcpClient: McpClientService
  ) {}

  async extractClaims(context: ThreadContext): Promise<Claim[]> {
    try {
      // Focus on the most recent post or root post for claim extraction
      const targetPost = context.posts.length > 1
        ? context.posts[context.posts.length - 1]
        : context.rootPost;

      logger.debug('Extracting claims from post', {
        postId: targetPost.id,
        contentLength: targetPost.content.length
      });

      // Use simple heuristic for now - in production could use AI for better extraction
      const claims = this.extractClaimsHeuristic(targetPost.content);

      logger.debug('Claims extracted', {
        claimCount: claims.length,
        claims: claims.map(c => c.text.substring(0, 50))
      });

      return claims;

    } catch (error) {
      logger.error('Failed to extract claims:', error);
      return [];
    }
  }

  private extractClaimsHeuristic(content: string): Claim[] {
    const claims: Claim[] = [];

    // Look for factual statements
    const sentences = content
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    for (const sentence of sentences) {
      // Simple heuristics for factual claims
      const factualIndicators = [
        /\b(is|are|was|were|has|have|will|would|can|could)\b/i,
        /\b(according to|research shows|studies indicate|data shows)\b/i,
        /\b(percent|percentage|million|billion|trillion)\b/i,
        /\b(in \d{4}|since \d{4}|by \d{4})\b/i,
        /\b(increase|decrease|rose|fell|higher|lower)\b/i
      ];

      const factualScore = factualIndicators.reduce((score, pattern) => {
        return score + (pattern.test(sentence) ? 0.2 : 0);
      }, 0);

      if (factualScore >= 0.4 && sentence.length < 200) {
        claims.push({
          text: sentence,
          confidence: Math.min(factualScore, 1.0),
          context: 'extracted from content'
        });
      }
    }

    // Return top 3 most confident claims
    return claims
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
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

      // Get MCP tools for search
      const tools = await this.mcpClient.tools();

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

  private async verifySingleClaim(
    claim: Claim,
    tools: Record<string, any>
  ): Promise<{
    verifiedClaim: VerifiedClaim;
    evidence: Evidence[];
    searchQueries: number;
  }> {
    // Create search queries for the claim
    const searchQueries = this.generateSearchQueries(claim.text);
    let searchCount = 0;
    const evidence: Evidence[] = [];

    // Build verification prompt
    const prompt = `Verify this claim using web search: "${claim.text}"

Instructions:
1. Search for reliable sources about this claim
2. Evaluate the evidence found
3. Provide a verdict: accurate, mostly accurate, mixed, mostly inaccurate, inaccurate, or unverifiable
4. Explain your reasoning based on the sources

Use the available search tools to find information about this claim.`;

    try {
      // Use AI with MCP tools to verify the claim
      const result = await this.aiService.generateText(
        prompt,
        'factcheck',
        {
          tools,
          // stopWhen: stepCountIs(5), // Limit to 5 search steps - commented out for compatibility
          maxRetries: 1
        }
      );

      // Extract evidence from tool results
      if (result.toolResults) {
        for (const toolResult of result.toolResults) {
          searchCount++;
          const extractedEvidence = this.extractEvidenceFromSearch(toolResult);
          evidence.push(...extractedEvidence);
        }
      }

      // Parse AI response for verdict
      const verification = this.parseVerificationResponse(result.text, claim.text, evidence);

      return {
        verifiedClaim: verification,
        evidence,
        searchQueries: searchCount
      };

    } catch (error) {
      logger.error('Error verifying single claim:', error);

      return {
        verifiedClaim: {
          claim: claim.text,
          verdict: 'unverifiable',
          confidence: 0.1,
          evidence: [],
          reasoning: 'Verification failed due to technical error'
        },
        evidence: [],
        searchQueries: searchCount
      };
    }
  }

  private generateSearchQueries(claim: string): string[] {
    // Simple query generation - in production could use AI for better queries
    const queries = [claim];

    // Add variations
    if (claim.length > 50) {
      const words = claim.split(' ');
      const keyWords = words.filter(w =>
        w.length > 3 &&
        !['this', 'that', 'they', 'have', 'been', 'will', 'said'].includes(w.toLowerCase())
      );

      if (keyWords.length > 3) {
        queries.push(keyWords.slice(0, 5).join(' '));
      }
    }

    return queries.slice(0, 2); // Limit to 2 queries per claim
  }

  private extractEvidenceFromSearch(toolResult: any): Evidence[] {
    const evidence: Evidence[] = [];

    try {
      // Parse search results (format depends on MCP tool response)
      const results = toolResult.result || toolResult.content || [];

      if (Array.isArray(results)) {
        for (const result of results.slice(0, 3)) { // Top 3 results
          if (result.url && result.title) {
            evidence.push({
              source: this.extractDomain(result.url),
              title: result.title,
              url: result.url,
              excerpt: result.snippet || result.description,
              reliability: this.assessSourceReliability(result.url),
              relevance: 0.8 // Default relevance
            });
          }
        }
      }

    } catch (error) {
      logger.warn('Failed to extract evidence from search result:', error);
    }

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

  private assessSourceReliability(url: string): number {
    const domain = this.extractDomain(url);

    // Simple reliability scoring based on known reliable sources
    const reliableSources = {
      'reuters.com': 0.95,
      'apnews.com': 0.95,
      'bbc.com': 0.9,
      'cnn.com': 0.8,
      'nytimes.com': 0.85,
      'washingtonpost.com': 0.85,
      'npr.org': 0.9,
      'nature.com': 0.95,
      'science.org': 0.95,
      'pubmed.ncbi.nlm.nih.gov': 0.95,
      'who.int': 0.9,
      'cdc.gov': 0.9,
      'gov': 0.8, // General government domains
      'edu': 0.85, // Educational institutions
      'org': 0.7  // Non-profit organizations
    };

    // Check exact matches first
    if (reliableSources[domain]) {
      return reliableSources[domain];
    }

    // Check domain endings
    for (const [ending, score] of Object.entries(reliableSources)) {
      if (domain.endsWith(ending)) {
        return score;
      }
    }

    // Default reliability for unknown sources
    return 0.5;
  }

  private parseVerificationResponse(
    aiResponse: string,
    claim: string,
    evidence: Evidence[]
  ): VerifiedClaim {
    // Simple parsing of AI response
    // In production, would use structured output or better parsing

    const verdictRegex = /verdict:\s*(accurate|mostly accurate|mixed|mostly inaccurate|inaccurate|unverifiable)/i;
    const match = aiResponse.match(verdictRegex);

    let verdict: VerifiedClaim['verdict'] = 'unverifiable';
    if (match) {
      verdict = match[1].toLowerCase() as VerifiedClaim['verdict'];
    }

    // Estimate confidence based on evidence quality
    const avgReliability = evidence.length > 0
      ? evidence.reduce((sum, e) => sum + e.reliability, 0) / evidence.length
      : 0.1;

    const confidence = Math.min(avgReliability * (evidence.length > 0 ? 1 : 0.1), 1.0);

    return {
      claim,
      verdict,
      confidence,
      evidence: evidence.slice(0, 3), // Top 3 pieces of evidence
      reasoning: aiResponse.substring(0, 300) // First 300 chars as reasoning
    };
  }

  private calculateOverallAssessment(verifiedClaims: VerifiedClaim[]): {
    verdict: VerifiedClaim['verdict'];
    confidence: number;
    reasoning: string;
  } {
    if (verifiedClaims.length === 0) {
      return {
        verdict: 'unverifiable',
        confidence: 0.1,
        reasoning: 'No claims could be processed'
      };
    }

    // Calculate average confidence
    const avgConfidence = verifiedClaims.reduce((sum, claim) => sum + claim.confidence, 0) / verifiedClaims.length;

    // Determine overall verdict based on individual verdicts
    const verdictCounts = verifiedClaims.reduce((counts, claim) => {
      counts[claim.verdict] = (counts[claim.verdict] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);

    const mostCommonVerdict = Object.entries(verdictCounts)
      .sort(([,a], [,b]) => b - a)[0][0] as VerifiedClaim['verdict'];

    return {
      verdict: mostCommonVerdict,
      confidence: avgConfidence,
      reasoning: `Based on verification of ${verifiedClaims.length} claims with average confidence ${(avgConfidence * 100).toFixed(0)}%`
    };
  }

  private deduplicateAndRankSources(evidence: Evidence[]): Evidence[] {
    const uniqueSources = new Map<string, Evidence>();

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
    return {
      verifiedClaims: claims.map(claim => ({
        claim: claim.text,
        verdict: 'unverifiable' as const,
        confidence: 0.1,
        evidence: [],
        reasoning: 'Unable to verify - search service unavailable'
      })),
      sources: [],
      overallAssessment: {
        verdict: 'unverifiable',
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
}