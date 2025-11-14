import logger from '@/utils/logger';

/**
 * Lightweight prompt injection detector
 * Detects suspicious patterns and logs for review
 * NEVER blocks content - only sanitizes and logs
 */

export interface InjectionDetection {
  detected: boolean;
  patterns: string[];
  sanitized: string;
}

export class InjectionDetector {
  // Common injection patterns (OWASP-based)
  // Note: No global flag needed since we're just checking existence, not extracting all matches
  private static readonly PATTERNS = {
    instructionOverride: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|directives?)/i,
    roleManipulation: /(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(a|an)\s+\w+/i,
    contextBreaking: /---+\s*(end|start|new|system)|===+\s*(end|start|new)/i,
    systemReference: /\[(system|user|assistant|context)\]|<\|(system|user|end)\|>/i,
    dataExfiltration: /repeat\s+(your|the)\s+(instructions?|prompt|system)/i,
    jailbreak: /(developer|debug|admin)\s+mode|jailbreak|bypass\s+safety/i,
  };

  /**
   * Detect injection patterns in user content
   */
  detect(content: string, context?: {
    mentionId?: string;
    postId?: string;
    authorId?: string;
    postUri?: string;
  }): InjectionDetection {
    const normalized = this.normalize(content);
    const detectedPatterns: string[] = [];

    // Check each pattern category
    for (const [category, pattern] of Object.entries(InjectionDetector.PATTERNS)) {
      if (pattern.test(normalized)) {
        detectedPatterns.push(category);
      }
    }

    const detected = detectedPatterns.length > 0;

    // If detected, log for review
    if (detected) {
      this.logDetection(content, detectedPatterns, context);
    }

    // Sanitize content (always safe to use)
    const sanitized = this.sanitize(normalized, detected);

    return {
      detected,
      patterns: detectedPatterns,
      sanitized
    };
  }

  /**
   * Normalize content to catch obfuscation attempts
   */
  private normalize(text: string): string {
    // Unicode normalization
    let normalized = text.normalize('NFKC');

    // Remove zero-width characters
    normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Remove control characters
    normalized = normalized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    return normalized;
  }

  /**
   * Sanitize content by escaping dangerous patterns
   * Never blocks - just makes content safe for prompts
   */
  private sanitize(text: string, hasInjection: boolean): string {
    if (!hasInjection) {
      return text;
    }

    let sanitized = text;

    // Escape prompt delimiters
    sanitized = sanitized
      .replace(/═{3,}/g, '---')
      .replace(/━{3,}/g, '---')
      .replace(/\[SYSTEM\]/gi, '[filtered]')
      .replace(/\[USER\]/gi, '[filtered]')
      .replace(/\[ASSISTANT\]/gi, '[filtered]')
      .replace(/<\|system\|>/gi, '[filtered]')
      .replace(/<\|user\|>/gi, '[filtered]')
      .replace(/<\|end\|>/gi, '[filtered]');

    // Collapse excessive whitespace
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
    sanitized = sanitized.replace(/[ \t]+/g, ' ');

    // Limit length
    if (sanitized.length > 10000) {
      sanitized = sanitized.substring(0, 10000) + '...[truncated]';
    }

    return sanitized.trim();
  }

  /**
   * Log detected injection attempt with pubky link for review
   */
  private logDetection(
    content: string,
    patterns: string[],
    context?: {
      mentionId?: string;
      postId?: string;
      authorId?: string;
      postUri?: string;
    }
  ): void {
    // Build pubky link if we have the URI
    const pubkyLink = context?.postUri
      ? `https://app.pubky.org/thread/${encodeURIComponent(context.postUri)}`
      : undefined;

    logger.warn('⚠️  Potential prompt injection detected', {
      mentionId: context?.mentionId,
      postId: context?.postId,
      authorId: context?.authorId,
      postUri: context?.postUri,
      pubkyLink,
      patterns,
      contentPreview: content.substring(0, 200),
      contentLength: content.length,
      message: 'Review this mention manually if needed'
    });

    // Also log as a structured event for potential monitoring dashboards
    logger.info('injection_detection', {
      event: 'prompt_injection_detected',
      mention_id: context?.mentionId,
      post_id: context?.postId,
      author_id: context?.authorId,
      post_uri: context?.postUri,
      pubky_link: pubkyLink,
      patterns_detected: patterns,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Batch process multiple pieces of content (e.g., thread)
   */
  detectBatch(items: Array<{
    content: string;
    id: string;
    authorId: string;
    uri?: string;
  }>): Array<{
    id: string;
    detected: boolean;
    patterns: string[];
    sanitized: string;
  }> {
    return items.map(item => {
      const result = this.detect(item.content, {
        postId: item.id,
        authorId: item.authorId,
        postUri: item.uri
      });

      return {
        id: item.id,
        detected: result.detected,
        patterns: result.patterns,
        sanitized: result.sanitized
      };
    });
  }
}
