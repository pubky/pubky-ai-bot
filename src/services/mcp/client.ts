import { experimental_createMCPClient } from '@ai-sdk/mcp';
import appConfig from '@/config';
import logger from '@/utils/logger';
import { withTimeout } from '@/utils/time';

export class McpClientService {
  private client: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null;
  private isConnected = false;

  async connectHTTP(): Promise<void> {
    if (!appConfig.mcp.brave.enabled) {
      logger.info('MCP Brave client disabled in configuration');
      return;
    }

    try {
      const connectPromise = experimental_createMCPClient({
        transport: {
          type: 'http',
          url: appConfig.mcp.brave.baseUrl,
          headers: appConfig.mcp.brave.headers
        }
      });

      this.client = await withTimeout(connectPromise, appConfig.mcp.brave.connectTimeoutMs);
      this.isConnected = true;

      logger.info(`MCP client connected to ${appConfig.mcp.brave.baseUrl}`);
    } catch (error) {
      logger.error('Failed to connect MCP client:', error);
      throw error;
    }
  }

  async tools(): Promise<Record<string, any>> {
    if (!this.client || !this.isConnected) {
      throw new Error('MCP client not connected. Call connectHTTP() first.');
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