import { Redis as RedisClient } from 'ioredis';

import { config } from '../config/env.js';
import log from '../logger/index.js';
import { formatError } from './errors.js';

/**
 * Standard structure for events published to the runtime event stream.
 * These events are consumed by the search indexer and other downstream services.
 */
type RuntimeStreamEvent = {
  eventType: string;
  thingId: string;
  interactionType: 'property' | 'event';
  name: string;
  subscriptionId: string;
  deliveryId?: string;
  payloadBase64?: string;
  contentType?: string;
  timestamp?: string;
  sourceProtocol?: string;
  requiresResponse?: boolean;
  detail?: string;
};

let redisPromise: Promise<RedisClient> | null = null;

/**
 * Creates and initializes a new Redis/Valkey client.
 */
async function createRedisClient(): Promise<RedisClient> {
  const client = new RedisClient(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (error: unknown) => {
    log.error(`Valkey error: ${formatError(error)}`);
  });

  await client.connect();
  return client;
}

/**
 * Returns a promise that resolves to the singleton Redis/Valkey client instance.
 * Initializes the client on first call.
 */
async function getRedisClient(): Promise<RedisClient> {
  if (!redisPromise) {
    redisPromise = createRedisClient().catch((error) => {
      redisPromise = null;
      throw error;
    });
  }

  return redisPromise;
}

/**
 * Converts a value to a string suitable for a Redis field.
 */
function toFieldValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}

/**
 * Publishes an event to the configured Valkey stream.
 *
 * @param event The runtime stream event to publish.
 * @returns A promise that resolves when the event has been added to the stream.
 * @throws {Error} if publishing fails.
 */
export async function publishRuntimeStreamEvent(event: RuntimeStreamEvent): Promise<void> {
  const client = await getRedisClient();
  const fields = [
    'event_type',
    event.eventType,
    'thing_id',
    event.thingId,
    'interaction_type',
    event.interactionType,
    'name',
    event.name,
    'subscription_id',
    event.subscriptionId,
    'delivery_id',
    toFieldValue(event.deliveryId),
    'payload_base64',
    toFieldValue(event.payloadBase64),
    'content_type',
    toFieldValue(event.contentType),
    'timestamp',
    event.timestamp || new Date().toISOString(),
    'source_protocol',
    toFieldValue(event.sourceProtocol),
    'requires_response',
    toFieldValue(event.requiresResponse || false),
    'detail',
    toFieldValue(event.detail),
  ] as const;

  await client.xadd(config.streamName, '*', ...fields);
}

/**
 * Pings the Valkey server to check for reachability.
 *
 * @returns A promise resolving to true if reachable, false otherwise.
 */
export async function pingValkey(): Promise<boolean> {
  try {
    const client = await getRedisClient();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Closes the Valkey client connection and resets the singleton instance.
 */
export async function closeValkeyClient(): Promise<void> {
  if (!redisPromise) {
    return;
  }

  const client = await redisPromise.catch(() => null);
  redisPromise = null;
  await client?.quit().catch(() => undefined);
}
