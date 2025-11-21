export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
    .slice(0, 10);
}

export function sanitizeForWordlist(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * Clean markdown-formatted URLs from text
 * Converts [text](url) or [domain.com](https://domain.com) to just the URL
 * Also removes parentheses around URLs and tracking parameters
 * @param text - Text that may contain markdown-formatted URLs
 * @returns Text with cleaned plain URLs
 */
export function cleanMarkdownUrls(text: string): string {
  // Step 1: Convert markdown links [text](url) to just the URL
  let cleaned = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$2');

  // Step 2: Remove parentheses around standalone URLs
  cleaned = cleaned.replace(/\((https?:\/\/[^\s)]+)\)/g, '$1');

  // Step 3: Remove query parameters (includes all tracking params like ?utm_source=...)
  cleaned = cleaned.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1');

  return cleaned;
}