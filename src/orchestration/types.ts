import { EventEnvelope } from '@/core/events';
import { Mention } from '@/types/mention';
import { ThreadContext } from '@/types/thread';
import { Logger } from 'winston';

export interface RoutingDecision {
  intent: 'summary' | 'factcheck' | 'unknown';
  confidence: number;
  reason?: string;
  method: 'heuristic' | 'llm';
}

export interface ActionWorker {
  id: 'summary' | 'factcheck';
  eventName: 'action.summary.requested.v1' | 'action.factcheck.requested.v1';
  consume(event: EventEnvelope): Promise<void>;
}

export interface WorkerContext {
  event: EventEnvelope;
  mention: Mention;
  services: Services;
  logger: Logger;
  runId: string;
  thread: () => Promise<ThreadContext>;
}

export interface WorkerResult {
  success: boolean;
  reply?: {
    text: string;
    parentUri: string;
  };
  artifacts?: Record<string, any>;
  error?: {
    code: string;
    message: string;
  };
}

export interface Services {
  ai: any;
  safety: any;
  reply: any;
  thread: any;
  mcp: any;
  pubky: any;
  metrics: any;
}

export interface HeuristicMatch {
  intent: 'summary' | 'factcheck';
  confidence: number;
  matchedKeywords: string[];
  reason: string;
}

export interface ClassificationRequest {
  content: string;
  context?: {
    authorId: string;
    postId: string;
    hasThread: boolean;
  };
}