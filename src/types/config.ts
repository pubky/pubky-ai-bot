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
    defaultTimeoutMs: z.number().min(1000).max(120000)
  }),
  safety: z.object({
    wordlist: z.array(z.string()),
    blockOnMatch: z.boolean()
  }),
  mcp: z.object({
    brave: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().min(1), // MCP server base URL
      connectTimeoutMs: z.number().min(1000).max(30000),
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