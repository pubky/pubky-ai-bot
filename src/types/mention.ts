export interface Mention {
  mentionId: string;
  postId: string;
  authorId: string;
  content: string;
  url?: string;
  receivedAt: string;
  status: 'received' | 'processing' | 'completed' | 'failed';
  lastError?: string;
}

export interface Post {
  id: string;
  uri: string;
  content: string;
  authorId: string;
  createdAt: string;
  parentUri?: string;
  metadata?: Record<string, any>;
}