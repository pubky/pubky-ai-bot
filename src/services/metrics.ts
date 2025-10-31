import client from 'prom-client';
import logger from '@/utils/logger';

export class MetricsService {
  private readonly registry: client.Registry;

  // Counters
  private readonly mentionsTotal: client.Counter<string>;
  private readonly actionsTotal: client.Counter<string>;
  private readonly repliesTotal: client.Counter<string>;

  // Histograms
  private readonly actionDuration: client.Histogram<string>;
  private readonly llmDuration: client.Histogram<string>;
  private readonly mcpDuration: client.Histogram<string>;
  private readonly pubkyPublishDuration: client.Histogram<string>;

  constructor() {
    this.registry = new client.Registry();

    // Initialize counters
    this.mentionsTotal = new client.Counter({
      name: 'grok_mentions_total',
      help: 'Total number of mentions processed',
      labelNames: ['status'],
      registers: [this.registry]
    });

    this.actionsTotal = new client.Counter({
      name: 'grok_actions_total',
      help: 'Total number of actions executed',
      labelNames: ['action', 'status'],
      registers: [this.registry]
    });

    this.repliesTotal = new client.Counter({
      name: 'grok_replies_total',
      help: 'Total number of replies published',
      labelNames: ['action'],
      registers: [this.registry]
    });

    // Initialize histograms
    this.actionDuration = new client.Histogram({
      name: 'grok_action_duration_seconds',
      help: 'Action execution time in seconds',
      labelNames: ['action'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry]
    });

    this.llmDuration = new client.Histogram({
      name: 'grok_llm_duration_seconds',
      help: 'LLM request duration in seconds',
      labelNames: ['kind'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry]
    });

    this.mcpDuration = new client.Histogram({
      name: 'grok_mcp_duration_seconds',
      help: 'MCP tool call duration in seconds',
      labelNames: ['tool'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry]
    });

    this.pubkyPublishDuration = new client.Histogram({
      name: 'grok_pubky_publish_duration_seconds',
      help: 'Pubky publish duration in seconds',
      buckets: [0.1, 0.5, 1, 2, 5],
      registers: [this.registry]
    });

    // Register default metrics
    client.collectDefaultMetrics({ register: this.registry });

    logger.info('Metrics service initialized');
  }

  // Counter methods
  incrementMentions(status: 'received' | 'processed' | 'failed'): void {
    this.mentionsTotal.inc({ status });
  }

  incrementActions(action: string, status: 'started' | 'completed' | 'failed'): void {
    this.actionsTotal.inc({ action, status });
  }

  incrementReplies(action: string): void {
    this.repliesTotal.inc({ action });
  }

  // Histogram methods
  recordActionDuration(action: string, durationSeconds: number): void {
    this.actionDuration.observe({ action }, durationSeconds);
  }

  recordLLMDuration(kind: 'classifier' | 'summary' | 'factcheck', durationSeconds: number): void {
    this.llmDuration.observe({ kind }, durationSeconds);
  }

  recordMCPDuration(tool: string, durationSeconds: number): void {
    this.mcpDuration.observe({ tool }, durationSeconds);
  }

  recordPubkyPublishDuration(durationSeconds: number): void {
    this.pubkyPublishDuration.observe(durationSeconds);
  }

  // Timer helpers
  startActionTimer(action: string) {
    const startTime = Date.now();
    return () => {
      const duration = (Date.now() - startTime) / 1000;
      this.recordActionDuration(action, duration);
    };
  }

  startLLMTimer(kind: 'classifier' | 'summary' | 'factcheck') {
    const startTime = Date.now();
    return () => {
      const duration = (Date.now() - startTime) / 1000;
      this.recordLLMDuration(kind, duration);
    };
  }

  startMCPTimer(tool: string) {
    const startTime = Date.now();
    return () => {
      const duration = (Date.now() - startTime) / 1000;
      this.recordMCPDuration(tool, duration);
    };
  }

  startPubkyTimer() {
    const startTime = Date.now();
    return () => {
      const duration = (Date.now() - startTime) / 1000;
      this.recordPubkyPublishDuration(duration);
    };
  }

  // Export metrics
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getRegistry(): client.Registry {
    return this.registry;
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      await this.getMetrics();
      return true;
    } catch (error) {
      logger.error('Metrics health check failed:', error);
      return false;
    }
  }
}