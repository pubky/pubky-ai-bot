import { generateText, generateObject } from 'ai';
import appConfig from '@/config';
import logger from '@/utils/logger';
import { withTimeout } from '@/utils/time';

type ProviderName = 'openai' | 'anthropic' | 'groq' | 'openrouter';

interface ProviderClient {
  client: any;
  name: ProviderName;
}

export class AIService {
  private providerClients: Map<ProviderName, any> = new Map();
  private initializationPromises: Map<ProviderName, Promise<any>> = new Map();

  private async initializeProvider(provider: ProviderName): Promise<any> {
    // Return existing promise if already initializing
    if (this.initializationPromises.has(provider)) {
      return this.initializationPromises.get(provider);
    }

    const initPromise = this.doInitializeProvider(provider);
    this.initializationPromises.set(provider, initPromise);

    try {
      const client = await initPromise;
      this.providerClients.set(provider, client);
      return client;
    } catch (error) {
      this.initializationPromises.delete(provider);
      throw error;
    }
  }

  private async doInitializeProvider(provider: ProviderName): Promise<any> {
    const apiKey = appConfig.ai.apiKeys[provider];

    if (!apiKey) {
      throw new Error(`Provider ${provider} API key not found in configuration`);
    }

    if (apiKey.startsWith('dummy-')) {
      throw new Error(`Provider ${provider} API key not configured`);
    }

    try {
      switch (provider) {
        case 'openai': {
          const { createOpenAI } = await import('@ai-sdk/openai');
          return createOpenAI({ apiKey });
        }
        case 'anthropic': {
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          return createAnthropic({ apiKey });
        }
        case 'groq': {
          // Groq custom implementation using OpenAI-compatible API
          const { createOpenAI } = await import('@ai-sdk/openai');
          return createOpenAI({
            apiKey,
            baseURL: 'https://api.groq.com/openai/v1'
          });
        }
        case 'openrouter': {
          // OpenRouter custom implementation using OpenAI-compatible API
          const { createOpenAI } = await import('@ai-sdk/openai');
          return createOpenAI({
            apiKey,
            baseURL: 'https://openrouter.ai/api/v1'
          });
        }
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    } catch (error) {
      logger.error(`Failed to initialize ${provider} provider:`, error);
      throw new Error(`Provider ${provider} initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getAvailableProviders(): Promise<ProviderClient[]> {
    const providers: ProviderClient[] = [];
    const primaryProvider = appConfig.ai.primaryProvider;
    const fallbackProviders = appConfig.ai.fallbackProviders || [];

    // Build ordered list: primary first, then fallbacks
    const providerOrder: ProviderName[] = [primaryProvider];
    fallbackProviders.forEach(provider => {
      if (provider !== primaryProvider) {
        providerOrder.push(provider);
      }
    });

    // Initialize providers in order
    for (const providerName of providerOrder) {
      try {
        const client = await this.initializeProvider(providerName);
        providers.push({ client, name: providerName });
        logger.debug(`Provider ${providerName} initialized successfully`);
      } catch (error) {
        logger.warn(`Provider ${providerName} failed to initialize:`, error);
      }
    }

    if (providers.length === 0) {
      throw new Error('No AI providers available - check configuration and API keys');
    }

    return providers;
  }

  private async getModel(purpose: 'summary' | 'factcheck' | 'classifier') {
    const model = appConfig.ai.models[purpose];
    const providers = await this.getAvailableProviders();

    // Use the first available provider
    const { client, name } = providers[0];
    logger.debug(`Using provider ${name} for ${purpose} with model ${model}`);

    return client(model);
  }

  private async executeWithFallback<T>(
    operation: (client: any, providerName: ProviderName) => Promise<T>,
    purpose: 'summary' | 'factcheck' | 'classifier'
  ): Promise<T> {
    const model = appConfig.ai.models[purpose];
    const providers = await this.getAvailableProviders();

    let lastError: Error | null = null;

    for (const { client, name } of providers) {
      try {
        logger.debug(`Attempting ${purpose} with provider ${name} using model ${model}`);
        const modelInstance = client(model);
        return await operation(modelInstance, name);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        logger.warn(`Provider ${name} failed for ${purpose}:`, error);

        // If this was the last provider, throw the error
        if (providers.indexOf({ client, name }) === providers.length - 1) {
          break;
        }
      }
    }

    throw new Error(`All AI providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  async generateText(
    prompt: string,
    purpose: 'summary' | 'factcheck',
    options?: {
      tools?: any;
      stopWhen?: any;
      maxRetries?: number;
    }
  ): Promise<{ text: string; usage?: any; toolResults?: any[]; provider?: ProviderName }> {
    const maxTokens = appConfig.ai.maxTokens[purpose];
    const timeout = appConfig.limits.defaultTimeoutMs;
    const startTime = Date.now();

    try {
      const result = await this.executeWithFallback(
        async (model, providerName) => {
          const response = await withTimeout(
            generateText({
              model,
              prompt,
              maxTokens,
              tools: options?.tools,
              maxRetries: options?.maxRetries || 1
            }),
            timeout
          );

          return {
            text: response.text,
            usage: response.usage,
            toolResults: response.toolResults,
            provider: providerName
          };
        },
        purpose
      );

      const duration = Date.now() - startTime;
      logger.debug(`AI text generation completed in ${duration}ms`, {
        purpose,
        provider: result.provider,
        tokenCount: result.usage?.totalTokens
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`AI text generation failed after ${duration}ms:`, error);
      throw error;
    }
  }

  async generateObject<T>(
    prompt: string,
    schema: any,
    purpose: 'classifier' = 'classifier'
  ): Promise<{ object: T; usage?: any; provider?: ProviderName }> {
    const maxTokens = appConfig.ai.maxTokens[purpose];
    const temperature = purpose === 'classifier' ? appConfig.ai.classifier.temperature : undefined;
    const timeout = appConfig.limits.defaultTimeoutMs;
    const startTime = Date.now();

    try {
      const result = await this.executeWithFallback(
        async (model, providerName) => {
          const response = await withTimeout(
            generateObject({
              model,
              schema,
              prompt,
              maxTokens,
              temperature
            }),
            timeout
          );

          return {
            object: response.object as T,
            usage: response.usage,
            provider: providerName
          };
        },
        purpose
      );

      const duration = Date.now() - startTime;
      logger.debug(`AI object generation completed in ${duration}ms`, {
        purpose,
        provider: result.provider,
        tokenCount: result.usage?.totalTokens
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`AI object generation failed after ${duration}ms:`, error);
      throw error;
    }
  }

  // Health check method to verify provider availability
  async healthCheck(): Promise<{
    primaryProvider: ProviderName;
    availableProviders: ProviderName[];
    totalProviders: number
  }> {
    try {
      const providers = await this.getAvailableProviders();
      return {
        primaryProvider: appConfig.ai.primaryProvider,
        availableProviders: providers.map(p => p.name),
        totalProviders: providers.length
      };
    } catch (error) {
      logger.error('AI service health check failed:', error);
      throw error;
    }
  }
}