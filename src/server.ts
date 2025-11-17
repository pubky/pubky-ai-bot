import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

// Infrastructure
import { redis } from '@/infrastructure/redis/connection';
import { db } from '@/infrastructure/database/connection';

// Core
import { EventBus } from '@/core/event-bus';
import { IdempotencyService } from '@/core/idempotency';

// Services
import { AIService } from '@/services/ai';
import { SafetyService } from '@/services/safety';
import { MetricsService } from '@/services/metrics';
import { RateLimitService } from '@/services/rate-limit';
import { BlacklistService } from '@/services/blacklist';
import { PubkyService } from '@/services/pubky';
import { ThreadService } from '@/services/thread';
import { ReplyService } from '@/services/reply';
import { ClassifierService } from '@/services/classifier';
import { SummaryService } from '@/services/summary';
import { FactcheckWebSearchService } from '@/services/factcheck-websearch';
import { McpClientService } from '@/services/mcp/client';
import { MentionPoller } from '@/services/poller';

// Orchestration & Workers
import { Router } from '@/orchestration/router';
import { SummaryWorker } from '@/actions/summary/worker';
import { FactcheckWorker } from '@/actions/factcheck/worker';

// API
import { createHealthRouter } from '@/api/health';
import { createMetricsRouter } from '@/api/metrics';
import { errorHandler, notFoundHandler } from '@/api/error-handler';

// Config & Utils
import appConfig from '@/config';
import logger from '@/utils/logger';

class PubkyBot {
  private app: express.Application;
  private server: any;

  // Infrastructure
  private eventBus: EventBus;
  private idempotency: IdempotencyService;

  // Services
  private aiService: AIService;
  private safetyService: SafetyService;
  private metricsService: MetricsService;
  private rateLimitService: RateLimitService;
  private blacklistService: BlacklistService;
  private pubkyService: PubkyService;
  private threadService: ThreadService;
  private replyService: ReplyService;
  private classifierService: ClassifierService;
  private summaryService: SummaryService;
  private factcheckService: FactcheckWebSearchService;
  private mcpClient: McpClientService;

  // Orchestration & Workers
  private router: Router;
  private summaryWorker: SummaryWorker;
  private factcheckWorker: FactcheckWorker;
  private poller: MentionPoller;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    // NOTE: setupErrorHandling() is called in start() AFTER routes are registered
    // This is critical - error handlers must be registered last or they intercept all requests
  }

  private setupMiddleware(): void {
    this.app.use(helmet());
    this.app.use(cors(appConfig.server.cors));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      logger.debug('HTTP Request', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }

  private async initializeServices(): Promise<void> {
    // Core infrastructure
    this.eventBus = new EventBus();
    this.idempotency = new IdempotencyService();

    // Base services
    this.aiService = new AIService();
    this.safetyService = new SafetyService();
    this.metricsService = new MetricsService();
    this.rateLimitService = new RateLimitService(
      redis.getClient(),
      appConfig.rateLimit.maxRequests,
      appConfig.rateLimit.windowMinutes
    );
    this.blacklistService = new BlacklistService(
      redis.getClient(),
      appConfig.blacklist.publicKeys
    );
    this.mcpClient = new McpClientService();

    // Domain services - PubkyService must be initialized with async factory pattern
    this.pubkyService = await PubkyService.create();
    this.threadService = new ThreadService(this.pubkyService);
    this.replyService = new ReplyService(this.pubkyService, this.safetyService);
    this.classifierService = new ClassifierService(this.aiService);
    this.summaryService = new SummaryService(this.aiService);
    this.factcheckService = new FactcheckWebSearchService(this.aiService);

    // Orchestration
    this.router = new Router(
      this.eventBus,
      this.classifierService,
      this.idempotency,
      this.metricsService,
      this.rateLimitService,
      this.blacklistService
    );

    // Workers
    this.summaryWorker = new SummaryWorker(
      this.eventBus,
      this.idempotency,
      this.summaryService,
      this.threadService,
      this.replyService,
      this.safetyService,
      this.metricsService
    );

    this.factcheckWorker = new FactcheckWorker(
      this.eventBus,
      this.idempotency,
      this.factcheckService,
      this.threadService,
      this.replyService,
      this.safetyService,
      this.metricsService
    );

    // Poller
    this.poller = new MentionPoller(
      this.pubkyService,
      this.eventBus,
      this.idempotency,
      this.metricsService
    );
  }

  private setupRoutes(): void {
    // Health endpoints
    const healthRouter = createHealthRouter({
      db,
      redis,
      pubky: this.pubkyService,
      mcp: this.mcpClient,
      router: this.router,
      summaryWorker: this.summaryWorker,
      factcheckWorker: this.factcheckWorker,
      poller: this.poller
    });

    this.app.use('/api', healthRouter);

    // Metrics endpoint
    const metricsRouter = createMetricsRouter(this.metricsService);
    this.app.use('/', metricsRouter);

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Pubky AI Bot',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Setup error handlers - MUST be called AFTER setupRoutes()
   *
   * CRITICAL: Express middleware order matters. These handlers catch unmatched
   * routes and errors. If registered before routes, they intercept ALL requests.
   */
  private setupErrorHandling(): void {
    this.app.use(notFoundHandler);
    this.app.use(errorHandler);
  }

  async start(): Promise<void> {
    try {
      logger.info('Starting Pubky AI Bot...');

      // Connect to infrastructure
      await this.connectInfrastructure();

      // Initialize services (must be done after infrastructure is connected)
      await this.initializeServices();

      // Setup routes (must be done after services are initialized)
      this.setupRoutes();

      // Setup error handlers (MUST be after routes, or 404 handler intercepts everything)
      this.setupErrorHandling();

      // Initialize event bus
      await this.eventBus.initializeStreams();

      // Connect MCP client if enabled
      if (appConfig.mcp.brave.enabled) {
        try {
          await this.mcpClient.connect();
        } catch (error) {
          logger.info('MCP client unavailable, continuing without it. Factcheck will use OpenAI web search instead.');
        }
      } else {
        logger.info('MCP Brave client disabled. Factcheck will use OpenAI web search.');
      }

      // Start orchestration components
      await this.startOrchestration();

      // Start HTTP server
      await this.startHttpServer();

      // Start mention polling
      await this.poller.start();

      logger.info('Pubky AI Bot started successfully', {
        port: appConfig.server.port,
        environment: process.env.NODE_ENV,
        features: appConfig.features
      });

    } catch (error) {
      logger.error('Failed to start server:', error);
      await this.stop();
      process.exit(1);
    }
  }

  private async connectInfrastructure(): Promise<void> {
    logger.info('Connecting to infrastructure...');

    // Connect Redis
    await redis.connect();

    // Verify database connection
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    // Run database migrations
    logger.info('Running database migrations...');
    const { DatabaseMigrator } = await import('@/infrastructure/database/migrator');
    const migrator = new DatabaseMigrator();
    await migrator.runMigrations();

    logger.info('Infrastructure connections established');
  }

  private async startOrchestration(): Promise<void> {
    logger.info('Starting orchestration components...');

    // Start router
    await this.router.start();

    // Start workers if features are enabled
    if (appConfig.features.summary) {
      await this.summaryWorker.start();
    }

    if (appConfig.features.factcheck) {
      await this.factcheckWorker.start();
    }

    logger.info('Orchestration components started');
  }

  private async startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(appConfig.server.port, appConfig.server.host, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`HTTP server listening on ${appConfig.server.host}:${appConfig.server.port}`);
          resolve(undefined);
        }
      });

      this.server.on('error', (error: Error) => {
        logger.error('HTTP server error:', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    logger.info('Stopping Pubky AI Bot...');

    try {
      // Stop poller first (if initialized)
      if (this.poller) {
        await this.poller.stop();
      }

      // Stop HTTP server
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server.close(() => resolve());
        });
      }

      // Close MCP client (if initialized)
      if (this.mcpClient) {
        await this.mcpClient.close();
      }

      // Close infrastructure connections
      await redis.disconnect();
      await db.close();

      logger.info('Pubky AI Bot stopped successfully');

    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }

  getApp(): express.Application {
    return this.app;
  }
}

// Handle process signals
function setupSignalHandlers(server: PubkyBot): void {
  const signals = ['SIGINT', 'SIGTERM'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      await server.stop();
      process.exit(0);
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new PubkyBot();

  setupSignalHandlers(server);

  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default PubkyBot;
