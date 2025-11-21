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
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info')
  }),
  redis: z.object({
    url: z.string().min(1) // Redis URL with redis:// protocol
  }),
  postgresql: z.object({
    url: z.string(),
    poolSize: z.number().min(1).max(100),
    ssl: z.boolean()
  }),
  pubky: z.object({
    network: z.enum(['mainnet', 'testnet']).default('testnet'),
    homeserverUrl: z.string().min(1), // Can be URL or pubkey
    botMnemonic: z.string().min(1), // REQUIRED: 12-24 word mnemonic phrase
    nexusApiUrl: z.string().optional(), // Nexus API base URL
    authUsername: z.string().optional(), // HTTP Basic Auth username
    authPassword: z.string().optional(), // HTTP Basic Auth password
    // botPublicKey is now derived from mnemonic, not configured
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
      summary: z.number().min(100).max(10000).default(1500),
      factcheck: z.number().min(100).max(10000).default(1500),
      classifier: z.number().min(50).max(2000).default(500)
    }),
    classifier: z.object({
      temperature: z.number().min(0).max(2).default(0.1)
    })
  }),
  search: z.object({
    braveMcp: z.object({
      endpoint: z.string().min(1), // MCP endpoint URL
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
    defaultTimeoutMs: z.number().min(1000).max(120000),
    classifierTimeoutMs: z.number().min(1000).max(60000).optional().default(12000), // 12s default, up to 60s for reasoning models
    factcheckTimeoutMs: z.number().min(1000).max(300000).optional().default(180000), // 90s for reasoning models
    thread: z.object({
      maxDepth: z.number().min(10).max(500).default(100),
      maxPosts: z.number().min(50).max(5000).default(1500),
      maxTokensForAI: z.number().min(1000).max(50000).default(15000),
      tokenWarningThreshold: z.number().min(1000).max(30000).default(10000)
    })
  }),
  safety: z.object({
    wordlist: z.array(z.string()),
    blockOnMatch: z.boolean()
  }),
  mcp: z.object({
    brave: z.discriminatedUnion('enabled', [
      z.object({
        enabled: z.literal(false),
        transport: z.enum(['http', 'sse']).optional(),
        baseUrl: z.string().optional(),
        connectTimeoutMs: z.number().optional(),
        maxResults: z.number().optional(),
        timeoutMs: z.number().optional(),
        headers: z.record(z.string()).optional()
      }),
      z.object({
        enabled: z.literal(true),
        transport: z.enum(['http', 'sse']).default('sse'),
        baseUrl: z.string().min(1),
        connectTimeoutMs: z.number().min(1000).max(30000),
        maxResults: z.number().min(1).max(20),
        timeoutMs: z.number().min(1000).max(60000),
        headers: z.record(z.string()).optional()
      })
    ])
  }),
  rateLimit: z.object({
    maxRequests: z.number().min(1).max(1000).default(10),
    windowMinutes: z.number().min(1).max(1440).default(120) // Max 24 hours
  }),
  blacklist: z.object({
    publicKeys: z.preprocess(
      (val) => {
        // Handle empty string or undefined
        if (!val || val === '') return [];
        // Handle comma-separated string
        if (typeof val === 'string') {
          return val.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
        // Already an array
        return val;
      },
      z.array(z.string())
    )
  }),
  budget: z.object({
    enabled: z.boolean().default(false),
    defaultDailyTokens: z.number().min(1000).max(5000000).default(200000)
  }).default({ enabled: false, defaultDailyTokens: 200000 })
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Services {
  // Will be defined as we create services
}
