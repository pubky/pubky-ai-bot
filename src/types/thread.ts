import { Post } from './mention';

export interface ThreadParticipant {
  publicKey: string;
  username?: string;
  displayName: string; // Falls back to shortened public key if no username
}

export interface ThreadContext {
  rootPost: Post;
  posts: Post[];
  participants: string[]; // Keep for backward compatibility
  participantProfiles: ThreadParticipant[]; // New field with resolved usernames
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