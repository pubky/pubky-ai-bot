import winston from 'winston';

// Get log level from environment or defaults
// We can't import appConfig here due to circular dependency
const getLogLevel = (): string => {
  // First check direct environment variable
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  // Then fall back to environment-based defaults
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const logger = winston.createLogger({
  level: getLogLevel(),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'pubky-ai-bot' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;