import { randomUUID } from 'crypto';

export function generateId(): string {
  return randomUUID();
}

export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function generateCorrelationId(prefix?: string): string {
  const id = Math.random().toString(36).substring(2, 12);
  return prefix ? `${prefix}_${id}` : id;
}