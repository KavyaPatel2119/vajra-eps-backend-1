import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import logger from '../config/logger';

type CreateAdapter = (pubClient: Redis, subClient: Redis) => unknown;

function resolveRedisUrl() {
  return process.env.SOCKET_IO_REDIS_URL || process.env.REDIS_URL || process.env.BULLMQ_REDIS_URL;
}

export async function setupRedisSocketAdapter(io: SocketIOServer) {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    logger.info('Socket.IO Redis adapter disabled: SOCKET_IO_REDIS_URL/REDIS_URL not configured');
    return;
  }

  let createAdapter: CreateAdapter;
  try {
    // Optional at build time, required when Redis Socket.IO scaling is enabled.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createAdapter = require('@socket.io/redis-adapter').createAdapter;
  } catch (error) {
    logger.warn('Socket.IO Redis adapter package is not installed. Run npm install in backend to enable it.');
    return;
  }

  const pubClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (error) => logger.error('Socket.IO Redis pub client error:', error));
  subClient.on('error', (error) => logger.error('Socket.IO Redis sub client error:', error));

  await Promise.all([pubClient.connect().catch(() => undefined), subClient.connect().catch(() => undefined)]);
  io.adapter(createAdapter(pubClient, subClient) as any);
  logger.info('Socket.IO Redis adapter enabled');
}
