import Redis from 'ioredis';
import logger from '../config/logger';

export type PeerConnectionState = {
  userId: string;
  examId: string;
  role: 'STUDENT' | 'FACULTY';
  socketId: string;
  isScreenSharing?: boolean;
};

const redisUrl = process.env.SOCKET_STATE_REDIS_URL || process.env.SOCKET_IO_REDIS_URL || process.env.REDIS_URL;
let redisClient: Redis | null | undefined;

const localSessionToSocket = new Map<string, string>();
const localSocketToSession = new Map<string, string>();
const localPeers = new Map<string, PeerConnectionState>();

function getRedis() {
  if (!redisUrl) return null;
  if (redisClient !== undefined) return redisClient;

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  redisClient.on('error', (error) => logger.warn('Socket state Redis error:', error));
  return redisClient;
}

async function safeRedis<T>(operation: (client: Redis) => Promise<T>, fallback: () => T | Promise<T>) {
  const client = getRedis();
  if (!client) return fallback();

  try {
    if (client.status === 'wait') {
      await client.connect();
    }
    return await operation(client);
  } catch (error) {
    logger.warn('Falling back to local socket state', error);
    return fallback();
  }
}

const sessionKey = (sessionId: string) => `socket:session:${sessionId}`;
const socketSessionKey = (socketId: string) => `socket:bound-session:${socketId}`;
const peerKey = (socketId: string) => `socket:peer:${socketId}`;
const examPeersKey = (examId: string) => `socket:exam:${examId}:peers`;

export async function registerSessionSocketState(sessionMongoId: string, socketId: string) {
  const sessionId = String(sessionMongoId);
  await safeRedis(
    async (client) => {
      await client
        .multi()
        .set(sessionKey(sessionId), socketId, 'EX', 24 * 60 * 60)
        .set(socketSessionKey(socketId), sessionId, 'EX', 24 * 60 * 60)
        .exec();
    },
    () => {
      localSessionToSocket.set(sessionId, socketId);
      localSocketToSession.set(socketId, sessionId);
    }
  );
}

export async function unregisterSocketState(socketId: string) {
  await safeRedis(
    async (client) => {
      const sessionId = await client.get(socketSessionKey(socketId));
      const peerRaw = await client.get(peerKey(socketId));
      const peer = peerRaw ? (JSON.parse(peerRaw) as PeerConnectionState) : null;
      const tx = client.multi().del(socketSessionKey(socketId)).del(peerKey(socketId));
      if (sessionId) tx.del(sessionKey(sessionId));
      if (peer?.examId) tx.srem(examPeersKey(peer.examId), socketId);
      await tx.exec();
    },
    () => {
      const sessionId = localSocketToSession.get(socketId);
      if (sessionId) {
        localSessionToSocket.delete(sessionId);
        localSocketToSession.delete(socketId);
      }
      localPeers.delete(socketId);
    }
  );
}

export async function getSocketIdForSessionState(sessionMongoId: string) {
  const sessionId = String(sessionMongoId);
  return safeRedis(
    (client) => client.get(sessionKey(sessionId)),
    () => localSessionToSocket.get(sessionId) || null
  );
}

export async function setPeerState(peer: PeerConnectionState) {
  await safeRedis(
    async (client) => {
      await client
        .multi()
        .set(peerKey(peer.socketId), JSON.stringify(peer), 'EX', 24 * 60 * 60)
        .sadd(examPeersKey(peer.examId), peer.socketId)
        .expire(examPeersKey(peer.examId), 24 * 60 * 60)
        .exec();
    },
    () => {
      localPeers.set(peer.socketId, peer);
    }
  );
}

export async function getPeerState(socketId: string) {
  return safeRedis(
    async (client) => {
      const raw = await client.get(peerKey(socketId));
      return raw ? (JSON.parse(raw) as PeerConnectionState) : null;
    },
    () => localPeers.get(socketId) || null
  );
}

export async function updatePeerScreenSharing(socketId: string, isScreenSharing: boolean) {
  const peer = await getPeerState(socketId);
  if (!peer) return null;
  const next = { ...peer, isScreenSharing };
  await setPeerState(next);
  return next;
}

export async function removePeerState(socketId: string) {
  await unregisterSocketState(socketId);
}

export async function listPeerStatesInExam(examId: string) {
  return safeRedis(
    async (client) => {
      const socketIds = await client.smembers(examPeersKey(examId));
      if (socketIds.length === 0) return [];
      const rows = await client.mget(socketIds.map(peerKey));
      return rows
        .map((raw) => (raw ? (JSON.parse(raw) as PeerConnectionState) : null))
        .filter((peer): peer is PeerConnectionState => Boolean(peer));
    },
    () => Array.from(localPeers.values()).filter((peer) => peer.examId === examId)
  );
}
