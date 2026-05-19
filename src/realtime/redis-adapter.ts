import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import logger from '../config/logger';
import { lookup } from 'dns/promises';

type CreateAdapter = (pubClient: Redis, subClient: Redis) => unknown;

function resolveRedisUrl() {
  return process.env.SOCKET_IO_REDIS_URL || process.env.REDIS_URL || process.env.BULLMQ_REDIS_URL;
}

async function attemptDnsLookup(hostname: string) {
  try {
    await lookup(hostname);
    return true;
  } catch (err) {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  // Pre-check DNS for the Redis host to avoid noisy repeated getaddrinfo errors
  let hostname: string | null = null;
  try {
    const parsed = new URL(redisUrl);
    hostname = parsed.hostname;
  } catch (err) {
    // ignore parsing errors; continue to attempt connection
  }

  if (hostname) {
    const ok = await attemptDnsLookup(hostname);
    if (!ok) {
      logger.warn(`Socket.IO Redis adapter: DNS lookup failed for host '${hostname}'. Adapter will be disabled until a reachable Redis URL is configured.`);
      return;
    }
  }

  const pubClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const subClient = pubClient.duplicate();

  // Throttle repeated identical errors to reduce log spam
  let lastPubErrorMs = 0;
  let lastSubErrorMs = 0;
  const throttleMs = 60_000; // 1 minute

  pubClient.on('error', (error) => {
    const now = Date.now();
    if (now - lastPubErrorMs > throttleMs) {
      lastPubErrorMs = now;
      logger.error('Socket.IO Redis pub client error:', error);
    }
  });
  subClient.on('error', (error) => {
    const now = Date.now();
    if (now - lastSubErrorMs > throttleMs) {
      lastSubErrorMs = now;
      logger.error('Socket.IO Redis sub client error:', error);
    }
  });

  // Connect with retries/backoff; if unable to connect, skip enabling adapter
  const maxAttempts = 3;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      // success
      io.adapter(createAdapter(pubClient, subClient) as any);
      logger.info('Socket.IO Redis adapter enabled');
      return;
    } catch (err) {
      const delay = 500 * Math.pow(2, attempt - 1);
      logger.warn(`Socket.IO Redis adapter connection attempt ${attempt} failed. Retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }

  logger.warn('Socket.IO Redis adapter could not connect after multiple attempts; adapter disabled. Verify your REDIS_URL/SOCKET_IO_REDIS_URL.');
  // Ensure we don't leave half-open clients
  try {
    pubClient.disconnect();
  } catch {}
  try {
    subClient.disconnect();
  } catch {}
}
