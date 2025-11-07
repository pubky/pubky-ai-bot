/**
 * Nexus API raw notification response
 */
export interface NexusNotification {
  id: string;
  author: {
    id: string;
    [key: string]: unknown;
  };
  tagged: Array<{
    uri: string;
    [key: string]: unknown;
  }>;
  post: {
    id: string;
    uri: string;
    content: string;
    indexed_at: number;
    [key: string]: unknown;
  };
  indexed_at: number;
  kind: string;
  [key: string]: unknown;
}

/**
 * Processed mention ready for database storage
 */
export interface Mention {
  mentionId: string;
  postId: string;
  authorId: string;
  content: string;
  url?: string;
  receivedAt: string;
  status: 'received' | 'processing' | 'completed' | 'failed';
  lastError?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Post data structure
 */
export interface Post {
  id: string;
  uri: string;
  content: string;
  authorId: string;
  createdAt: string;
  parentUri?: string;
  metadata?: Record<string, unknown>;
}