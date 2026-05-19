import { Server as SocketIOServer, Socket } from 'socket.io';
import { SurveillanceService } from '../modules/surveillance/surveillance.service';
import logger from '../config/logger';
import { registerSessionSocket, unregisterSocket } from './sessionSocketRegistry';
import { getSocketUser } from '../middleware/socket-auth.middleware';
import { Session } from '../database/schemas/session.schema';
import { assertExamVisibleToUser, assertSessionVisibleToUser } from '../common/utils/ownership';

const surveillanceService = new SurveillanceService();

/**
 * Join exam rooms, bind student session ↔ socket, persist surveillance:activity, notify faculty.
 */
export function setupExamSocketHandlers(io: SocketIOServer) {
  io.on('connection', (socket: Socket) => {
    socket.on('join-exam', async (data: { examId?: string; role?: 'STUDENT' | 'FACULTY' }) => {
      const user = getSocketUser(socket);
      if (!user) return;
      const examId = data?.examId != null ? String(data.examId).trim() : '';
      if (!examId) return;
      try {
        await assertExamVisibleToUser(examId, user);
      } catch {
        socket.emit('error', { message: 'Not authorized for this exam' });
        return;
      }
      void socket.join(`exam:${examId}`);
      if (user.role === 'FACULTY') {
        void socket.join(`exam:${examId}:faculty`);
      }
      logger.debug(`Socket ${socket.id} joined exam:${examId} role=${user.role}`);
    });

    socket.on('student:bind-session', async (data: { sessionId?: string; examId?: string; studentId?: string }) => {
      const user = getSocketUser(socket);
      if (!user || user.role !== 'STUDENT') return;
      const sessionId = data?.sessionId != null ? String(data.sessionId).trim() : '';
      const examId = data?.examId != null ? String(data.examId).trim() : '';
      if (!sessionId || !examId) return;
      try {
        await assertSessionVisibleToUser(sessionId, user);
      } catch {
        logger.warn(`Rejected unauthorized session bind for socket ${socket.id}`);
        return;
      }
      const session = await Session.findById(sessionId).select('studentId examId').lean();
      if (!session || String(session.studentId) !== user.id || String(session.examId) !== examId) {
        logger.warn(`Rejected session bind for socket ${socket.id}`);
        return;
      }
      await registerSessionSocket(sessionId, socket.id);
      void socket.join(`exam:${examId}`);
      void socket.join(`session:${sessionId}`);
      (socket.data as { boundSessionId?: string }).boundSessionId = sessionId;
      logger.debug(`Student socket ${socket.id} bound to session ${sessionId}`);
    });

    socket.on('surveillance:activity', async (data: Record<string, unknown>) => {
      try {
        const user = getSocketUser(socket);
        if (!user || user.role !== 'STUDENT') return;
        if (!data || typeof data !== 'object') return;
        const sessionId = String(data.sessionId ?? '');
        const examId = String(data.examId ?? '');
        if (!sessionId || !examId) return;
        const session = await Session.findById(sessionId).select('studentId examId').lean();
        if (!session || String(session.studentId) !== user.id || String(session.examId) !== examId) {
          logger.warn(`Rejected unauthorized surveillance activity from socket ${socket.id}`);
          return;
        }
        const safeData = { ...data, studentId: user.id };
        const log = await surveillanceService.createLog(safeData);
        const payload = {
          logId: log.logId,
          studentId: user.id,
          sessionId: data.sessionId,
          eventType: data.eventType,
          severity: data.severity,
          description: data.description,
          screenshotUrl: data.screenshotUrl,
          timestamp: log.eventTime,
        };
        io.to(`exam:${examId}:faculty`).emit('surveillance:activity-logged', payload);
        io.to(`exam:${examId}`).emit('surveillance:activity-logged', payload);
      } catch (error) {
        logger.error('surveillance:activity failed', error);
        socket.emit('error', { message: 'Failed to log surveillance activity' });
      }
    });

    socket.on('disconnect', () => {
      void unregisterSocket(socket.id);
    });
  });
}
