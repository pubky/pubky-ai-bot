import { EventBus } from '@/core/event-bus';
import { ActionRequestedV1, ActionCompletedV1, ActionFailedV1 } from '@/core/events';
import { IdempotencyService } from '@/core/idempotency';
import { FactcheckService } from '@/services/factcheck';
import { ThreadService } from '@/services/thread';
import { ReplyService, ReplyContent } from '@/services/reply';
import { SafetyService } from '@/services/safety';
import { MetricsService } from '@/services/metrics';
import { db } from '@/infrastructure/database/connection';
import { generateRunId } from '@/utils/ids';
import logger from '@/utils/logger';

export class FactcheckWorker {
  constructor(
    private eventBus: EventBus,
    private idempotency: IdempotencyService,
    private factcheckService: FactcheckService,
    private threadService: ThreadService,
    private replyService: ReplyService,
    private safetyService: SafetyService,
    private metrics: MetricsService
  ) {}

  async start(): Promise<void> {
    await this.eventBus.subscribe(
      'action.factcheck.requested.v1',
      'factcheck-workers',
      'factcheck-worker-001',
      this.handleFactcheckRequest.bind(this)
    );

    logger.info('Factcheck worker started and listening for requests');
  }

  private async handleFactcheckRequest(event: any): Promise<void> {
    const data = event.data as ActionRequestedV1;
    const runId = generateRunId();

    logger.debug('Processing factcheck request', {
      mentionId: data.mentionId,
      postId: data.postId,
      runId,
      eventId: event.id
    });

    const idempotencyKey = `action:factcheck:${data.mentionId}`;

    try {
      const result = await this.idempotency.guard(
        idempotencyKey,
        async () => {
          return this.executeFactcheck(data, runId);
        }
      );

      if (!result.executed) {
        logger.debug('Factcheck action already processed', {
          mentionId: data.mentionId,
          runId
        });
        return;
      }

      logger.debug('Factcheck action completed', {
        mentionId: data.mentionId,
        runId,
        success: result.result?.success
      });

    } catch (error) {
      logger.error('Failed to process factcheck request:', error);

      await this.emitFailedEvent(data, runId, error);
      this.metrics.incrementActions('factcheck', 'failed');
      throw error;
    }
  }

  private async executeFactcheck(
    data: ActionRequestedV1,
    runId: string
  ): Promise<{ success: boolean; executionId: string }> {
    const startTime = Date.now();
    const endActionTimer = this.metrics.startActionTimer('factcheck');
    this.metrics.incrementActions('factcheck', 'started');

    // Create action execution record
    const executionId = await this.createActionExecution(data.mentionId, 'factcheck');

    try {
      // Build thread context
      logger.debug('Building thread context for factcheck', {
        mentionId: data.mentionId,
        postId: data.postId,
        runId
      });

      const threadContext = await this.threadService.buildThreadContext(data.postId);

      // Extract claims from thread
      logger.debug('Extracting claims for verification', {
        mentionId: data.mentionId,
        postCount: threadContext.posts.length
      });

      const claims = await this.factcheckService.extractClaims(threadContext);

      if (claims.length === 0) {
        logger.debug('No verifiable claims found', {
          mentionId: data.mentionId
        });

        // Still send a helpful response
        const replyText = "I couldn't identify specific factual claims to verify in this content. If you have specific statements you'd like me to fact-check, please let me know!";

        let replyRef = null;
        if (data.parentUri) {
          replyRef = await this.replyService.publish(
            data.parentUri,
            replyText,
            data.mentionId
          );
        }

        await this.completeActionExecution(executionId, {
          durationMs: Date.now() - startTime,
          claimsProcessed: 0
        });

        await this.emitCompletedEvent(data, executionId, replyRef, {
          type: 'factcheck',
          claims: [],
          message: 'No claims found'
        });

        endActionTimer();
        this.metrics.incrementActions('factcheck', 'completed');
        return { success: true, executionId };
      }

      // Verify claims using search
      logger.debug('Verifying claims', {
        mentionId: data.mentionId,
        claimCount: claims.length
      });

      let factcheckResult = await this.factcheckService.verify(claims);

      // Clean MCP protocol data from the result before using it
      factcheckResult = this.cleanMcpData(factcheckResult);

      // Format reply
      const replyContent = this.formatFactcheckReply(factcheckResult);
      const replyText = this.replyService.compose(replyContent);

      // Safety check
      const safetyCheck = this.safetyService.performComprehensiveCheck(replyText);
      if (safetyCheck.blocked) {
        logger.warn('Factcheck reply blocked by safety check', {
          mentionId: data.mentionId,
          reason: safetyCheck.reason
        });

        throw new Error(`Reply blocked by safety check: ${safetyCheck.reason}`);
      }

      // Publish reply
      let replyRef = null;
      if (data.parentUri) {
        replyRef = await this.replyService.publish(
          data.parentUri,
          replyText,
          data.mentionId
        );

        this.metrics.incrementReplies('factcheck');
        logger.info('Factcheck reply published', {
          mentionId: data.mentionId,
          replyId: replyRef.id,
          verdict: factcheckResult.overallAssessment.verdict
        });
      }

      // Store artifacts
      const artifacts = this.formatArtifacts(factcheckResult);
      await this.storeArtifacts(executionId, artifacts);

      // Complete action execution
      await this.completeActionExecution(executionId, {
        durationMs: factcheckResult.metrics.processingTimeMs,
        claimsProcessed: factcheckResult.metrics.claimsProcessed,
        sourcesFound: factcheckResult.metrics.sourcesFound
      });

      // Emit completion event
      await this.emitCompletedEvent(data, executionId, replyRef, artifacts);

      endActionTimer();
      this.metrics.incrementActions('factcheck', 'completed');

      return { success: true, executionId };

    } catch (error) {
      // Update execution with error
      await this.failActionExecution(executionId, error);
      endActionTimer();
      throw error;
    }
  }

  private cleanMcpData(data: any): any {
    // MCP protocol fields that should be removed
    const mcpFields = [
      'toolName',
      'toolInput',
      'bravewebsearch',
      'resultsfilter',
      'safesearch',
      'spellcheck',
      'textdecorations',
      'tool_calls',
      'tool_use',
      'function_calls'
    ];

    const cleanMcpResponse = (response: any): any => {
      if (!response) return response;

      if (typeof response === 'string') {
        // Clean string responses
        let cleaned = response;
        mcpFields.forEach(field => {
          // Remove JSON patterns like {"toolName": ...}
          const patterns = [
            new RegExp(`"${field}":\\s*[^,}]+[,}]`, 'gi'),
            new RegExp(`{[^}]*"${field}"[^}]*}`, 'gi')
          ];
          patterns.forEach(pattern => {
            cleaned = cleaned.replace(pattern, (match) => {
              // Keep structure but remove content
              return match.includes('}') ? '{}' : '';
            });
          });
        });
        return cleaned;
      }

      if (typeof response === 'object') {
        // Clone to avoid mutation
        const cleaned = Array.isArray(response) ? [...response] : { ...response };

        // Remove MCP fields
        if (!Array.isArray(cleaned)) {
          mcpFields.forEach(field => {
            delete cleaned[field];
            // Also check camelCase and snake_case variations
            delete cleaned[field.toLowerCase()];
            delete cleaned[field.replace(/([A-Z])/g, '_$1').toLowerCase()];
          });
        }

        // Recursively clean nested objects
        Object.keys(cleaned).forEach(key => {
          if (cleaned[key] && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanMcpResponse(cleaned[key]);
          }
        });

        return cleaned;
      }

      return response;
    };

    // Clean the entire data object
    const cleanedData = cleanMcpResponse(data);

    // Log if cleaning was needed
    const originalStr = JSON.stringify(data);
    const cleanedStr = JSON.stringify(cleanedData);
    if (originalStr !== cleanedStr) {
      logger.info('MCP protocol data was cleaned', {
        originalLength: originalStr.length,
        cleanedLength: cleanedStr.length
      });
    }

    return cleanedData;
  }

  private formatFactcheckReply(result: any): ReplyContent {
    // Validate result structure
    if (!result || typeof result !== 'object') {
      logger.error('Invalid factcheck result - not an object', {
        resultType: typeof result,
        result: JSON.stringify(result).substring(0, 500)
      });
      throw new Error('Invalid factcheck result structure');
    }

    const { overallAssessment, verifiedClaims, sources } = result;

    // Validate required fields
    if (!overallAssessment || !verifiedClaims) {
      logger.error('Invalid factcheck result structure - missing required fields', {
        hasOverall: !!overallAssessment,
        hasClaims: !!verifiedClaims,
        hasSources: !!sources,
        result: JSON.stringify(result).substring(0, 500)
      });
      throw new Error('Invalid factcheck result structure - cannot format reply');
    }

    // Build Grok-style narrative response
    let narrativeText = '';

    // Use the narrative summary from overallAssessment
    if (overallAssessment.narrative) {
      narrativeText = overallAssessment.narrative;
    } else if (overallAssessment.reasoning) {
      // Fallback to reasoning if narrative not available
      narrativeText = overallAssessment.reasoning;
    } else if (verifiedClaims.length > 0) {
      // Fallback to first claim's reasoning
      narrativeText = verifiedClaims[0].reasoning;
    } else {
      narrativeText = "I looked into this claim but couldn't find enough reliable information to verify it.";
    }

    // Add alternative perspectives if present
    const allPerspectives = verifiedClaims
      .filter(vc => vc.alternativePerspectives && vc.alternativePerspectives.length > 0)
      .flatMap(vc => vc.alternativePerspectives || []);

    if (allPerspectives.length > 0) {
      narrativeText += `\n\nAlternative perspective: ${allPerspectives[0]}`;
    }

    // Include top sources with credibility explanations
    const topSources = sources.slice(0, 3).map(source => ({
      title: source.title,
      url: source.url,
      // Include credibility explanation if available
      description: source.credibilityExplanation
        ? `${source.credibilityExplanation} (${source.credibilityRating || 'unknown reliability'}${source.perspective ? ', ' + source.perspective : ''})`
        : undefined
    }));

    const replyContent: ReplyContent = {
      verdict: narrativeText,
      sources: topSources,
      confidence: overallAssessment.confidence > 0.7 ? 'high' :
                  overallAssessment.confidence > 0.4 ? 'medium' : 'low'
    };

    return replyContent;
  }

  private formatArtifacts(result: any): Record<string, any> {
    return {
      type: 'factcheck',
      verifiedClaims: result.verifiedClaims,
      sources: result.sources,
      overallAssessment: result.overallAssessment,
      metrics: result.metrics
    };
  }

  private async createActionExecution(mentionId: string, actionId: string): Promise<string> {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO action_executions (mention_id, action_id, status)
       VALUES ($1, $2, 'started')
       RETURNING id`,
      [mentionId, actionId]
    );

    return rows[0].id;
  }

  private async completeActionExecution(
    executionId: string,
    metrics: { durationMs: number; claimsProcessed?: number; sourcesFound?: number }
  ): Promise<void> {
    await db.query(
      `UPDATE action_executions
       SET status = 'completed', completed_at = now(), metrics_json = $2
       WHERE id = $1`,
      [executionId, JSON.stringify(metrics)]
    );
  }

  private async failActionExecution(executionId: string, error: any): Promise<void> {
    const errorData = {
      message: error instanceof Error ? error.message : 'Unknown error',
      code: error.code || 'FACTCHECK_ERROR',
      stack: error instanceof Error ? error.stack : undefined
    };

    await db.query(
      `UPDATE action_executions
       SET status = 'failed', completed_at = now(), error_json = $2
       WHERE id = $1`,
      [executionId, JSON.stringify(errorData)]
    );
  }

  private async storeArtifacts(executionId: string, artifacts: any): Promise<void> {
    await db.query(
      `INSERT INTO artifacts (action_execution_id, type, payload_json)
       VALUES ($1, 'factcheck', $2)`,
      [executionId, JSON.stringify(artifacts)]
    );
  }

  private async emitCompletedEvent(
    data: ActionRequestedV1,
    executionId: string,
    replyRef: any,
    artifacts: any
  ): Promise<void> {
    const completedData: ActionCompletedV1 = {
      mentionId: data.mentionId,
      actionId: 'factcheck',
      executionId,
      reply: replyRef ? {
        text: replyRef.content,
        parentUri: replyRef.parentUri,
        replyUri: replyRef.uri
      } : undefined,
      artifacts
    };

    await this.eventBus.emit('action.factcheck.completed.v1', completedData, {
      correlationId: data.mentionId
    });
  }

  private async emitFailedEvent(
    data: ActionRequestedV1,
    runId: string,
    error: any
  ): Promise<void> {
    const failedData: ActionFailedV1 = {
      mentionId: data.mentionId,
      actionId: 'factcheck',
      executionId: runId,
      error: {
        code: error.code || 'FACTCHECK_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      retryable: true
    };

    await this.eventBus.emit('action.factcheck.failed.v1', failedData, {
      correlationId: data.mentionId
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Test claim extraction
      const testContext = {
        rootPost: {
          id: 'test',
          uri: 'test',
          content: 'The population of Tokyo is 14 million people.',
          authorId: 'system',
          createdAt: new Date().toISOString()
        },
        posts: [],
        participants: ['system'],
        depth: 1,
        totalTokens: 20,
        isComplete: true
      };

      const claims = await this.factcheckService.extractClaims(testContext);
      return claims.length >= 0; // Should work even if no claims found

    } catch (error) {
      logger.error('Factcheck worker health check failed:', error);
      return false;
    }
  }
}