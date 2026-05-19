import jwt from 'jsonwebtoken';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { JWT_CONFIG } from '../config';
import logger from '../config/logger';

export type SocketAuthUser = {
  id: string;
  email: string;
  role: 'STUDENT' | 'FACULTY';
  deviceId: string;
};

export function getSocketUser(socket: Socket): SocketAuthUser | null {
  return ((socket.data as { user?: SocketAuthUser }).user || null);
}

export function setupSocketAuth(io: SocketIOServer) {
  io.use((socket, next) => {
    try {
      const rawToken =
        socket.handshake.auth?.token ||
        socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';

      if (!token) {
        return next(new Error('Socket authentication required'));
      }

      const decoded = jwt.verify(token, JWT_CONFIG.SECRET as string) as any;
      const userId = String(decoded.userId || decoded.id || '').trim();
      const email = String(decoded.email || '').trim();
      const role = String(decoded.role || '').trim().toUpperCase();

      if (!userId || !email || !['STUDENT', 'FACULTY'].includes(role)) {
        return next(new Error('Invalid socket token'));
      }

      socket.data.user = {
        id: userId,
        email,
        role: role as 'STUDENT' | 'FACULTY',
        deviceId: String(decoded.deviceId || ''),
      };

      next();
    } catch (error) {
      logger.warn('Socket authentication failed', error);
      next(new Error('Socket authentication failed'));
    }
  });
}
