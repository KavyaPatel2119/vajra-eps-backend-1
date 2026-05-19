import {
  getSocketIdForSessionState,
  registerSessionSocketState,
  unregisterSocketState,
} from '../realtime/redis-state';

/**
 * Maps exam session Mongo _id to student Socket.IO id.
 * Uses Redis when configured, with local memory fallback for single-node development.
 */
export async function registerSessionSocket(sessionMongoId: string, socketId: string): Promise<void> {
  await registerSessionSocketState(sessionMongoId, socketId);
}

export async function unregisterSocket(socketId: string): Promise<void> {
  await unregisterSocketState(socketId);
}

export async function getSocketIdForSession(sessionMongoId: string): Promise<string | null> {
  return getSocketIdForSessionState(sessionMongoId);
}
