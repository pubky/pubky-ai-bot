import { experimental_createMCPClient } from '@ai-sdk/mcp';
import appConfig from '@/config';
import logger from '@/utils/logger';
import { withTimeout } from '@/utils/time';

export class McpClientService {
  private client: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null;
  private isConnected = false;

  async connect(): Promise<void> {
    if (!appConfig.mcp.brave.enabled) {
      logger.info('MCP Brave client disabled in configuration');
      return;
    }

    const tryConnect = async (transportType: 'http' | 'sse') => {
      const connectPromise = experimental_createMCPClient({
        transport: {
          type: transportType,
          url: appConfig.mcp.brave.baseUrl,
          headers: appConfig.mcp.brave.headers
        }
      });
      const client = await withTimeout(connectPromise, appConfig.mcp.brave.connectTimeoutMs);
      this.client = client;
      this.isConnected = true;
      logger.info(`MCP client connected (${transportType}) to ${appConfig.mcp.brave.baseUrl}`);
    };

    // Primary transport from config, fallback to the other on known HTTP incompatibilities
    const primary = appConfig.mcp.brave.transport;
    const secondary: 'http' | 'sse' = primary === 'http' ? 'sse' : 'http';

    try {
      await tryConnect(primary);
      return;
    } catch (error: any) {
      const msg = String(error?.message || error);
      const looksLikeWrongHttpEndpoint = /Cannot POST \/|HTTP 404/i.test(msg);
      const suggestFallback = looksLikeWrongHttpEndpoint || /does not support HTTP transport|server does not support HTTP/i.test(msg);

      if (primary === 'http' && suggestFallback) {
        logger.warn('HTTP MCP transport failed, retrying with SSE...', { reason: msg });
        await tryConnect('sse');
        return;
      }

      if (primary === 'sse' && /EventSource|SSE|stream/i.test(msg)) {
        logger.warn('SSE MCP transport failed, retrying with HTTP...', { reason: msg });
        await tryConnect('http');
        return;
      }

      logger.warn('Failed to connect MCP client:', error);
      throw error;
    }
  }

  async tools(): Promise<Record<string, any>> {
    if (!this.client || !this.isConnected) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    try {
      const tools = await withTimeout(
        this.client.tools(),
        appConfig.mcp.brave.timeoutMs
      );

      logger.debug('Retrieved MCP tools', {
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools)
      });

      return tools;
    } catch (error) {
      logger.error('Failed to retrieve MCP tools:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        this.isConnected = false;
        logger.info('MCP client connection closed');
      } catch (error) {
        logger.error('Error closing MCP client:', error);
      } finally {
        this.client = null;
      }
    }
  }

  isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isReady()) {
      return false;
    }

    try {
      await this.tools();
      return true;
    } catch (error) {
      logger.error('MCP health check failed:', error);
      return false;
    }
  }
}
