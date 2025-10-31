import { Request, Response, NextFunction } from 'express';
import logger from '@/utils/logger';

export interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
}

export function errorHandler(
  error: ErrorWithStatus,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If response was already sent, delegate to Express default error handler
  if (res.headersSent) {
    return next(error);
  }

  // Log the error
  logger.error('Express error handler caught error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Determine status code
  const statusCode = error.status || error.statusCode || 500;

  // Prepare error response
  const errorResponse = {
    error: {
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      status: statusCode,
      timestamp: new Date().toISOString(),
      path: req.path
    }
  };

  // Include stack trace in development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error = {
      ...errorResponse.error,
      stack: error.stack
    } as any;
  }

  // Send error response
  res.status(statusCode).json(errorResponse);
}

export function notFoundHandler(req: Request, res: Response): void {
  const errorResponse = {
    error: {
      message: 'Endpoint not found',
      status: 404,
      timestamp: new Date().toISOString(),
      path: req.path
    }
  };

  res.status(404).json(errorResponse);
}

export function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<any>
) {
  return (req: T, res: U, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}