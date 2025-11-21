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
 * @param text - Text that may contain markdown-formatted URLs
 * @returns Text with markdown URLs converted to plain URLs
 */
export function cleanMarkdownUrls(text: string): string {
  // Pattern matches markdown links: [text](url)
  // Captures the URL part and replaces the entire markdown link with just the URL
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$2');
}