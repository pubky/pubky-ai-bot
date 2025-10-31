import { Router } from 'express';
import { MetricsService } from '@/services/metrics';
import { asyncHandler } from '@/api/error-handler';

export function createMetricsRouter(metricsService: MetricsService) {
  const router = Router();

  router.get('/metrics', asyncHandler(async (req, res) => {
    const metrics = await metricsService.getMetrics();

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(metrics);
  }));

  return router;
}