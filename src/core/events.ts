export type EventName =
  | 'mention.received.v1'
  | 'action.summary.requested.v1'
  | 'action.summary.completed.v1'
  | 'action.summary.failed.v1'
  | 'action.factcheck.requested.v1'
  | 'action.factcheck.completed.v1'
  | 'action.factcheck.failed.v1';

export interface EventEnvelope<T = any> {
  id: string;
  type: EventName;
  ts: string;              // ISO timestamp
  correlationId?: string | undefined;  // usually mentionId
  key?: string | undefined;            // idempotency key
  data: T;
}

export interface MentionReceivedV1 {
  mentionId: string;
  postId: string;
  mentionedBy: string;
  content: string;
  url?: string;
  ts: string;
  metadata?: Record<string, any>;
}

export interface ActionRequestedV1 {
  mentionId: string;
  postId: string;
  parentUri?: string;
  intent: 'summary' | 'factcheck';
}

export interface ActionCompletedV1 {
  mentionId: string;
  actionId: string;
  executionId: string;
  reply?: {
    text: string;
    parentUri: string;
    replyUri: string;
  } | undefined;
  artifacts?: Record<string, any> | undefined;
  metrics?: {
    durationMs: number;
    tokensUsed?: number;
    sourcesCount?: number;
  } | undefined;
}

export interface ActionFailedV1 {
  mentionId: string;
  actionId: string;
  executionId: string;
  error: {
    code: string;
    message: string;
    stack?: string;
  };
  retryable: boolean;
}