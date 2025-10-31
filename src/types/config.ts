import { z } from 'zod';

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string(),
    port: z.number().min(1).max(65535),
    cors: z.object({
      origin: z.union([z.string(), z.array(z.string())]),
      credentials: z.boolean()
    })
  }),
  redis: z.object({
    url: z.string().url()
  }),
  postgresql: z.object({
    url: z.string(),
    poolSize: z.number().min(1).max(100),
    ssl: z.boolean()
  }),
  pubky: z.object({
    homeserverUrl: z.string().url(),
    botSecretKey: z.string().min(1),
    mentionPolling: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().min(1).max(300),
      batchSize: z.number().min(1).max(100)
    })
  }),
  ai: z.object({
    primaryProvider: z.enum(['openai', 'anthropic', 'groq', 'openrouter']),
    fallbackProviders: z.array(z.enum(['openai', 'anthropic', 'groq', 'openrouter'])).optional(),
    apiKeys: z.object({
      openai: z.string().optional(),
      anthropic: z.string().optional(),
      groq: z.string().optional(),
      openrouter: z.string().optional()
    }),
    models: z.object({
      summary: z.string(),
      factcheck: z.string(),
      classifier: z.string()
    }),
    maxTokens: z.object({
      summary: z.number().min(100).max(4000),
      factcheck: z.number().min(100).max(4000),
      classifier: z.number().min(50).max(1000)
    }),
    classifier: z.object({
      temperature: z.number().min(0).max(2).default(0)
    })
  }),
  search: z.object({
    braveMcp: z.object({
      endpoint: z.string().url(),
      apiKey: z.string().optional()
    })
  }),
  features: z.object({
    summary: z.boolean(),
    factcheck: z.boolean(),
    translate: z.boolean(),
    image: z.boolean()
  }),
  limits: z.object({
    maxConcurrentActions: z.number().min(1).max(20),
    defaultTimeoutMs: z.number().min(1000).max(120000)
  }),
  safety: z.object({
    wordlist: z.array(z.string()),
    blockOnMatch: z.boolean()
  }),
  mcp: z.object({
    brave: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().url(),
      connectTimeoutMs: z.number().min(1000).max(30000),
      toolName: z.string(),
      maxResults: z.number().min(1).max(20),
      timeoutMs: z.number().min(1000).max(60000),
      headers: z.record(z.string()).optional()
    })
  })
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Services {
  // Will be defined as we create services
}