import { Post } from './mention';

export interface ThreadContext {
  rootPost: Post;
  posts: Post[];
  participants: string[];
  depth: number;
  totalTokens: number;
  isComplete: boolean;
  metadata?: {
    topics?: string[];
    sentiment?: string;
    complexity?: number;
  };
}

export interface ThreadValidation {
  isComplete: boolean;
  issues: string[];
  warnings: string[];
  recommendations: string[];
}