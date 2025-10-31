import * as fs from 'fs';
import * as path from 'path';
import { ConfigSchema, type Config } from '@/types/config';
import logger from '@/utils/logger';

function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with process.env.VAR_NAME or fallback values
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value !== undefined) {
        return value;
      }

      // Provide fallback values for development
      const fallbacks: Record<string, string> = {
        'DATABASE_URL': 'postgres://user:pass@localhost:5432/grokbot',
        'REDIS_URL': 'redis://localhost:6379/0',
        'PUBKY_HOMESERVER_URL': 'https://example.com',
        'PUBKY_BOT_SECRET_KEY': 'dummy-secret-key-for-dev',
        'BRAVE_MCP_BASE_URL': 'http://localhost:8921',
        'BRAVE_MCP_TOKEN': 'Bearer dummy-token',
        // AI Provider Configuration
        'AI_PRIMARY_PROVIDER': 'groq',
        'OPENAI_API_KEY': 'dummy-openai-key',
        'ANTHROPIC_API_KEY': 'dummy-anthropic-key',
        'GROQ_API_KEY': 'dummy-groq-key',
        'OPENROUTER_API_KEY': 'dummy-openrouter-key',
        // AI Model Configuration
        'AI_MODEL_SUMMARY': 'llama-3.1-8b-instant',
        'AI_MODEL_FACTCHECK': 'llama-3.1-8b-instant',
        'AI_MODEL_CLASSIFIER': 'llama-3.1-8b-instant',
        // AI Token Limits
        'AI_MAX_TOKENS_SUMMARY': '800',
        'AI_MAX_TOKENS_FACTCHECK': '800',
        'AI_MAX_TOKENS_CLASSIFIER': '200',
        // AI Classifier Settings
        'AI_CLASSIFIER_TEMPERATURE': '0'
      };

      return fallbacks[varName] || match;
    });
  } else if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  } else if (typeof obj === 'object' && obj !== null) {
    const resolved: any = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function loadConfig(): any {
  const env = process.env.NODE_ENV || 'development';
  const configDir = path.resolve(process.cwd(), 'config');

  // Load default config
  const defaultConfigPath = path.join(configDir, 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

  // Load environment-specific config if it exists
  const envConfigPath = path.join(configDir, `${env}.json`);
  let envConfig = {};
  if (fs.existsSync(envConfigPath)) {
    envConfig = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
  }

  // Deep merge configs (env config overrides default)
  return deepMerge(defaultConfig, envConfig);
}

function processSpecialValues(obj: any): any {
  if (typeof obj === 'string') {
    // Handle unresolved environment variables (optional fields)
    if (obj.startsWith('${') && obj.endsWith('}')) {
      // For fallbackProviders, return undefined if not set
      if (obj === '${AI_FALLBACK_PROVIDERS}') {
        return undefined;
      }
      return obj;
    }
    // Handle comma-separated arrays
    if (obj.includes(',')) {
      return obj.split(',').map(s => s.trim());
    }
    // Handle numeric strings
    if (/^\d+$/.test(obj)) {
      return parseInt(obj, 10);
    }
    // Handle float strings
    if (/^\d*\.\d+$/.test(obj)) {
      return parseFloat(obj);
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map(processSpecialValues);
  } else if (typeof obj === 'object' && obj !== null) {
    const processed: any = {};
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = processSpecialValues(value);
    }
    return processed;
  }
  return obj;
}

function validateConfig(): Config {
  try {
    const rawConfig = loadConfig();
    const resolvedConfig = resolveEnvVars(rawConfig);
    const processedConfig = processSpecialValues(resolvedConfig);
    const validated = ConfigSchema.parse(processedConfig);

    logger.info('Configuration loaded and validated successfully');
    return validated;
  } catch (error) {
    logger.error('Configuration validation failed:', error);
    throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export const appConfig = validateConfig();
export default appConfig;