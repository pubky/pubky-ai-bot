import { Router } from 'express';
import { asyncHandler } from '@/api/error-handler';
import logger from '@/utils/logger';
import appConfig from '@/config';

interface HealthServices {
  db: { healthCheck: () => Promise<boolean> };
  redis: { healthCheck: () => Promise<boolean> };
  pubky: { healthCheck: () => Promise<boolean> };
  mcp?: { healthCheck: () => Promise<boolean> };
  router?: { healthCheck: () => Promise<boolean> };
  summaryWorker?: { healthCheck: () => Promise<boolean> };
  factcheckWorker?: { healthCheck: () => Promise<boolean> };
  poller?: { healthCheck: () => Promise<boolean> };
}

export function createHealthRouter(services: HealthServices) {
  const router = Router();

  router.get('/health', asyncHandler(async (req, res) => {
    const startTime = Date.now();

    // Check individual service health
    const checks = await Promise.allSettled([
      checkService('database', services.db),
      checkService('redis', services.redis),
      checkService('pubky', services.pubky),
      services.mcp ? checkService('mcp', services.mcp) : Promise.resolve({ service: 'mcp', status: 'disabled', healthy: true }),
      services.router ? checkService('router', services.router) : Promise.resolve({ service: 'router', status: 'not_started', healthy: true }),
      services.summaryWorker ? checkService('summary_worker', services.summaryWorker) : Promise.resolve({ service: 'summary_worker', status: 'not_started', healthy: true }),
      services.factcheckWorker ? checkService('factcheck_worker', services.factcheckWorker) : Promise.resolve({ service: 'factcheck_worker', status: 'not_started', healthy: true }),
      services.poller ? checkService('poller', services.poller) : Promise.resolve({ service: 'poller', status: 'not_started', healthy: true })
    ]);

    // Process results
    const serviceChecks = checks.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const serviceNames = ['database', 'redis', 'pubky', 'mcp', 'router', 'summary_worker', 'factcheck_worker', 'poller'];
        return {
          service: serviceNames[index] || 'unknown',
          status: 'error',
          healthy: false,
          error: result.reason instanceof Error ? result.reason.message : 'Unknown error'
        };
      }
    });

    // Determine overall health
    const allHealthy = serviceChecks.every(check => check.healthy);
    const overallStatus = allHealthy ? 'healthy' : 'unhealthy';

    const response = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      responseTime: Date.now() - startTime,
      pubky: {
        network: appConfig.pubky.network || 'testnet'
      },
      services: serviceChecks.reduce((acc, check) => {
        acc[check.service] = {
          status: check.status,
          healthy: check.healthy,
          ...(((check as any).error) && { error: (check as any).error })
        };
        return acc;
      }, {} as Record<string, any>)
    };

    const statusCode = allHealthy ? 200 : 503;
    res.status(statusCode).json(response);

    // Log health check results
    if (!allHealthy) {
      logger.warn('Health check failed', {
        unhealthyServices: serviceChecks.filter(c => !c.healthy).map(c => c.service)
      });
    }
  }));

  router.get('/health/ready', asyncHandler(async (req, res) => {
    // Readiness check - are we ready to serve traffic?
    const criticalServices = [
      services.db,
      services.redis
    ];

    const checks = await Promise.allSettled(
      criticalServices.map((service, index) => {
        const names = ['database', 'redis'];
        return checkService(names[index], service);
      })
    );

    const allReady = checks.every(result =>
      result.status === 'fulfilled' && result.value.healthy
    );

    if (allReady) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString()
      });
    }
  }));

  router.get('/health/live', asyncHandler(async (req, res) => {
    // Liveness check - is the process alive?
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  }));

  return router;
}

async function checkService(
  name: string,
  service: { healthCheck: () => Promise<boolean> }
): Promise<{
  service: string;
  status: string;
  healthy: boolean;
  error?: string;
}> {
  try {
    const healthy = await service.healthCheck();
    return {
      service: name,
      status: healthy ? 'healthy' : 'unhealthy',
      healthy
    };
  } catch (error) {
    return {
      service: name,
      status: 'error',
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}