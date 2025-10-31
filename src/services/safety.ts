import appConfig from '@/config';
import { sanitizeForWordlist } from '@/utils/text';
import logger from '@/utils/logger';

export interface SafetyCheckResult {
  blocked: boolean;
  matches: string[];
  reason?: string;
}

export class SafetyService {
  private wordlist: Set<string>;

  constructor() {
    this.wordlist = new Set(
      appConfig.safety.wordlist.map(word => sanitizeForWordlist(word))
    );
  }

  checkWordlist(text: string): SafetyCheckResult {
    const sanitized = sanitizeForWordlist(text);
    const matches: string[] = [];

    for (const bannedWord of this.wordlist) {
      if (sanitized.includes(bannedWord)) {
        matches.push(bannedWord);
      }
    }

    const blocked = appConfig.safety.blockOnMatch && matches.length > 0;

    if (blocked) {
      logger.warn('Content blocked by safety wordlist', {
        matches,
        textPreview: text.substring(0, 100)
      });
    }

    return {
      blocked,
      matches,
      reason: blocked ? `Content contains blocked terms: ${matches.join(', ')}` : undefined
    };
  }

  getSafeReplacementMessage(): string {
    return "I can't provide that type of content. Let me help you with something else.";
  }

  validateReply(content: string): SafetyCheckResult {
    return this.checkWordlist(content);
  }

  // Additional safety checks can be added here
  checkLength(text: string, maxLength: number = 2000): SafetyCheckResult {
    const blocked = text.length > maxLength;

    return {
      blocked,
      matches: [],
      reason: blocked ? `Content exceeds maximum length of ${maxLength} characters` : undefined
    };
  }

  performComprehensiveCheck(text: string): SafetyCheckResult {
    // Run all safety checks
    const wordlistCheck = this.checkWordlist(text);
    if (wordlistCheck.blocked) return wordlistCheck;

    const lengthCheck = this.checkLength(text);
    if (lengthCheck.blocked) return lengthCheck;

    return { blocked: false, matches: [] };
  }
}