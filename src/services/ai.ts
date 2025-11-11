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
          const { createGroq } = await import('@ai-sdk/groq');
          return createGroq({ apiKey });
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
  ): Promise<{ text: string; usage?: any; toolCalls?: any[]; toolResults?: any[]; provider?: ProviderName }> {
    const maxTokens = appConfig.ai.maxTokens[purpose];
    const timeout = appConfig.limits.defaultTimeoutMs;
    const startTime = Date.now();

    try {
      const result = await this.executeWithFallback(
        async (model, providerName) => {
          // Decide whether to force tool usage based on provider and model
          const modelId = appConfig.ai.models[purpose];
          const shouldForce = options?.tools
            ? this.shouldForceToolChoice(providerName, modelId)
            : false;

          const response = await withTimeout(
            generateText({
              model,
              prompt,
              tools: options?.tools,
              toolChoice: shouldForce ? 'required' : undefined,
              maxRetries: options?.maxRetries || 1
            }),
            timeout
          );

          try {
            logger.debug('AI tool usage debug', {
              provider: providerName,
              purpose,
              toolCalls: (response as any)?.toolCalls?.length || 0,
              toolResults: (response as any)?.toolResults?.length || 0
            });
          } catch {}

          return {
            text: response.text,
            usage: response.usage,
            toolCalls: (response as any).toolCalls,
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

  /**
   * Determine whether to force tool usage for a given provider/model.
   * We only force for providers/models known to reliably support tool calls.
   */
  private shouldForceToolChoice(provider: ProviderName, modelId: string): boolean {
    // OpenAI native supports tool calling well
    if (provider === 'openai') return true;

    // For OpenRouter, only force when using OpenAI-backed models via OpenRouter
    // e.g., 'openai/gpt-4o-mini'. Anthropic and some others may ignore tool calls via OpenRouter.
    if (provider === 'openrouter') {
      return /^openai\//i.test(modelId);
    }

    // Groq and Anthropic: be conservative (do not force) unless we verify support
    return false;
  }

  /**
   * Extract JSON from text that might be wrapped in markdown code blocks
   */
  private extractJsonFromText(text: string): any {
    // Try to find JSON in markdown code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      const jsonStr = codeBlockMatch[1].trim();
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // Continue to try other methods
      }
    }

    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        // Continue to try direct parse
      }
    }

    // Try direct parse as last resort
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Could not extract valid JSON from response: ${text.substring(0, 200)}...`);
    }
  }

  async generateObject<T>(
    prompt: string,
    schema: any,
    purpose: 'classifier' | 'factcheck' = 'classifier'
  ): Promise<{ object: T; usage?: any; provider?: ProviderName }> {
    const maxTokens = appConfig.ai.maxTokens[purpose];
    const temperature = purpose === 'classifier'
      ? appConfig.ai.classifier.temperature
      : purpose === 'factcheck'
        ? 0.3 // Lower temperature for factchecking (more deterministic)
        : undefined;
    const timeout = appConfig.limits.defaultTimeoutMs;
    const startTime = Date.now();

    try {
      const result = await this.executeWithFallback(
        async (model, providerName) => {
          try {
            // First try the standard generateObject approach
            const response = await withTimeout(
              generateObject({
                model,
                schema,
                prompt,
                temperature,
                maxRetries: 1
              }),
              timeout
            );

            return {
              object: response.object as T,
              usage: response.usage,
              provider: providerName
            };
          } catch (error: any) {
            // If parsing failed, try generateText and extract JSON manually
            if (error.message?.includes('parse') || error.message?.includes('No object generated')) {
              logger.debug(`Object generation failed for ${providerName}, trying text extraction`);

              // Use generateText instead
              const textResponse = await withTimeout(
                generateText({
                  model,
                  prompt: prompt + '\n\nPlease respond with valid JSON only.',
                  temperature,
                  maxRetries: 1
                }),
                timeout
              );

              // Extract JSON from the text response
              const extractedObject = this.extractJsonFromText(textResponse.text);

              // Validate against schema
              const validationResult = schema.safeParse(extractedObject);
              if (!validationResult.success) {
                throw new Error(`Schema validation failed: ${validationResult.error.message}`);
              }

              return {
                object: validationResult.data as T,
                usage: textResponse.usage,
                provider: providerName
              };
            }

            // Re-throw other errors
            throw error;
          }
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
