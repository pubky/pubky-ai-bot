import { EventEnvelope, EventName } from './events';
import { RedisStreams } from '@/infrastructure/redis/streams';
import { generateId, generateCorrelationId } from '@/utils/ids';
import { getCurrentTimestamp } from '@/utils/time';
import logger from '@/utils/logger';

export class EventBus {
  private streams: RedisStreams;
  private readonly STREAM_PREFIX = 'pubky';
  private readonly DLQ_STREAM = 'pubky:dlq';

  constructor() {
    this.streams = new RedisStreams();
  }

  private getStreamKey(eventType: EventName): string {
    const baseName = eventType.replace('.v1', '').replace('.', '_');
    return `${this.STREAM_PREFIX}:${baseName}`;
  }

  async emit<T>(eventType: EventName, data: T, options?: {
    correlationId?: string;
    key?: string;
  }): Promise<string> {
    const envelope: EventEnvelope<T> = {
      id: generateId(),
      type: eventType,
      ts: getCurrentTimestamp(),
      correlationId: options?.correlationId,
      key: options?.key,
      data
    };

    const streamKey = this.getStreamKey(eventType);
    const messageId = await this.streams.addToStream(streamKey, {
      envelope: JSON.stringify(envelope)
    });

    logger.debug(`Emitted event ${eventType}`, {
      eventId: envelope.id,
      correlationId: envelope.correlationId,
      messageId
    });

    return messageId;
  }

  async subscribe<T>(
    eventType: EventName,
    groupName: string,
    consumerName: string,
    handler: (envelope: EventEnvelope<T>) => Promise<void>
  ): Promise<void> {
    const streamKey = this.getStreamKey(eventType);

    // Create consumer group
    await this.streams.createConsumerGroup(streamKey, groupName);

    logger.info(`Subscribed to ${eventType} with group ${groupName}, consumer ${consumerName}`);

    // Start consuming
    this.consumeLoop(streamKey, groupName, consumerName, handler);
  }

  private async consumeLoop<T>(
    streamKey: string,
    groupName: string,
    consumerName: string,
    handler: (envelope: EventEnvelope<T>) => Promise<void>
  ): Promise<void> {
    while (true) {
      try {
        const messages = await this.streams.readFromGroup(streamKey, {
          groupName,
          consumerName,
          count: 5,
          block: 100  // Reduced from 5000ms to 100ms for faster processing
        });

        for (const message of messages) {
          try {
            const envelope = JSON.parse(message.fields.envelope) as EventEnvelope<T>;

            logger.debug(`Processing event ${envelope.type}`, {
              eventId: envelope.id,
              correlationId: envelope.correlationId,
              messageId: message.id
            });

            await handler(envelope);
            await this.streams.acknowledgMessage(streamKey, groupName, message.id);

            logger.debug(`Completed event ${envelope.type}`, {
              eventId: envelope.id,
              messageId: message.id
            });

          } catch (error) {
            logger.error(`Error processing message ${message.id}:`, error);

            // Move to DLQ after 3 retries (simplified - in production would track retry count)
            await this.streams.moveToDLQ(
              streamKey,
              this.DLQ_STREAM,
              groupName,
              message.id,
              { error: error instanceof Error ? error.message : 'Unknown error' }
            );
          }
        }
      } catch (error) {
        logger.error(`Error in consume loop for ${streamKey}:`, error);
        // Brief delay before retrying
        await new Promise(resolve => setTimeout(resolve, 100));  // Reduced from 1000ms to 100ms
      }
    }
  }

  async initializeStreams(): Promise<void> {
    // Create DLQ stream
    await this.streams.createConsumerGroup(this.DLQ_STREAM, 'dlq-processors', '0');
    logger.info('Event bus initialized');
  }
}