import { Server as SocketIOServer, Socket } from 'socket.io';
import logger from '../config/logger';
import { getSocketUser } from '../middleware/socket-auth.middleware';
import { assertExamVisibleToUser } from '../common/utils/ownership';
import {
  getPeerState,
  listPeerStatesInExam,
  removePeerState,
  setPeerState,
  updatePeerScreenSharing,
  type PeerConnectionState,
} from '../realtime/redis-state';

export function setupWebRTCHandlers(io: SocketIOServer) {
  io.on('connection', (socket: Socket) => {
    logger.info(`WebRTC peer connected: ${socket.id}`);

    /**
     * Student joins exam and registers for screen sharing
     * Payload: { userId, examId, role }
     */
    socket.on('webrtc:peer-join', async (data: { userId: string; examId: string; role: string }) => {
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

      const peerInfo: PeerConnectionState = {
        userId: user.id,
        examId,
        role: user.role,
        socketId: socket.id,
        isScreenSharing: false,
      };

      await setPeerState(peerInfo);
      logger.info(`${user.role} ${user.id} joined exam ${examId} - Socket: ${socket.id}`);

      socket.join(`exam:${examId}`);
      if (user.role === 'STUDENT') {
        io.to(`exam:${examId}:faculty`).emit('webrtc:student-available', {
          studentId: user.id,
          socketId: socket.id,
          examId,
        });
      }

      if (user.role === 'FACULTY') {
        socket.join(`exam:${examId}:faculty`);

        const peers = await listPeerStatesInExam(examId);
        for (const peer of peers) {
          if (peer.role !== 'STUDENT') continue;

          socket.emit(
            peer.isScreenSharing ? 'webrtc:student-screen-sharing' : 'webrtc:student-available',
            {
              studentId: peer.userId,
              socketId: peer.socketId,
              examId,
            }
          );
        }
      }
    });

    /**
     * Handle auto-start screen share event (triggered when exam session starts)
     * Payload: { sessionId, examId, studentId }
     */
    socket.on('exam:auto-start-screen-share', async (data: { sessionId: string; examId: string; studentId: string }) => {
      const { examId } = data;
      const peer = await getPeerState(socket.id);

      if (peer && peer.role === 'STUDENT' && peer.examId === examId) {
        logger.info(`Auto-starting screen share for student ${peer.userId} in exam ${examId}`);
        await updatePeerScreenSharing(socket.id, true);

        io.to(`exam:${examId}:faculty`).emit('webrtc:student-screen-active', {
          studentId: peer.userId,
          socketId: socket.id,
          examId,
          message: 'Student screen sharing started',
        });
      }
    });

    /**
     * Relay WebRTC offer signal from one peer to another
     * Payload: { to, from, data }
     */
    socket.on('webrtc:signal', async (data: { to: string; from: string; data: any }) => {
      const peer = await getPeerState(socket.id);
      if (!peer) return;
      const { to, data: signalData } = data;
      const targetPeer = await getPeerState(to);
      if (!targetPeer || targetPeer.examId !== peer.examId) {
        socket.emit('error', { message: 'Invalid WebRTC target' });
        return;
      }

      logger.debug(`Relaying signal from ${socket.id} to ${to}`);
      io.to(to).emit('webrtc:signal', {
        from: socket.id,
        data: signalData,
      });
    });

    /**
     * Fallback screen frames over Socket.IO.
     * This keeps faculty monitoring visible when WebRTC ICE/P2P cannot connect
     * across VM/NAT/firewall boundaries.
     */
    socket.on('webrtc:screen-frame', async (data: { examId: string; image: string; width?: number; height?: number; timestamp?: number }) => {
      const peer = await getPeerState(socket.id);
      if (!peer || peer.role !== 'STUDENT' || peer.examId !== data.examId || !peer.isScreenSharing) {
        return;
      }

      io.to(`exam:${data.examId}:faculty`).emit('webrtc:screen-frame', {
        examId: data.examId,
        studentId: peer.userId,
        socketId: socket.id,
        image: data.image,
        width: data.width,
        height: data.height,
        timestamp: data.timestamp || Date.now(),
      });
    });

    /**
     * Start screen sharing - student initiates stream
     * Payload: { examId }
     */
    socket.on('webrtc:start-screen-share', async (data: { examId: string }) => {
      const { examId } = data;
      const peer = await getPeerState(socket.id);

      if (peer && peer.role === 'STUDENT' && peer.examId === examId) {
        logger.info(`Student ${peer.userId} started screen share in exam ${examId}`);
        await updatePeerScreenSharing(socket.id, true);

        io.to(`exam:${examId}:faculty`).emit('webrtc:student-screen-sharing', {
          studentId: peer.userId,
          socketId: socket.id,
          examId,
        });
      }
    });

    /**
     * Stop screen sharing
     */
    socket.on('webrtc:stop-screen-share', async (data: { examId: string }) => {
      const { examId } = data;
      const peer = await getPeerState(socket.id);

      if (peer && peer.role === 'STUDENT' && peer.examId === examId) {
        logger.info(`Student ${peer.userId} stopped screen share in exam ${examId}`);
        await updatePeerScreenSharing(socket.id, false);

        io.to(`exam:${examId}:faculty`).emit('webrtc:student-screen-stopped', {
          studentId: peer.userId,
          socketId: socket.id,
          examId,
        });
      }
    });

    /**
     * Faculty requests student's screen
     * Payload: { studentSocketId, examId }
     */
    socket.on('webrtc:request-peer', async (data: { studentSocketId: string; examId: string }) => {
      const { studentSocketId, examId } = data;
      const faculty = await getPeerState(socket.id);
      const studentPeer = await getPeerState(studentSocketId);
      const socketStillConnected = (await io.in(studentSocketId).fetchSockets()).length > 0;

      if (faculty && faculty.role === 'FACULTY' && faculty.examId === examId) {
        // Reject stale/unavailable targets so faculty UI can recover from ghost sharing states.
        if (
          !socketStillConnected ||
          !studentPeer ||
          studentPeer.role !== 'STUDENT' ||
          studentPeer.examId !== examId ||
          studentPeer.isScreenSharing !== true
        ) {
          logger.warn(`Faculty ${faculty.userId} requested unavailable peer ${studentSocketId} in exam ${examId}`);

          socket.emit('webrtc:peer-unavailable', {
            studentSocketId,
            examId,
            reason: !socketStillConnected
              ? 'student-disconnected'
              : studentPeer?.isScreenSharing === true
                ? 'invalid-peer'
                : 'not-sharing',
          });

          if (studentPeer && studentPeer.role === 'STUDENT') {
            io.to(`exam:${examId}:faculty`).emit('webrtc:student-screen-stopped', {
              studentId: studentPeer.userId,
              socketId: studentSocketId,
              examId,
            });
          }
          return;
        }

        logger.info(`Faculty ${faculty.userId} requesting peer connection with student in exam ${examId}`);

        io.to(studentSocketId).emit('webrtc:peer-requested', {
          facultySocketId: socket.id,
          facultyId: faculty.userId,
          examId,
        });
      }
    });

    /**
     * Handle peer disconnect
     */
    socket.on('disconnect', async () => {
      const peer = await getPeerState(socket.id);

      if (peer) {
        logger.info(`${peer.role} ${peer.userId} disconnected`);

        io.to(`exam:${peer.examId}`).emit('webrtc:peer-disconnected', {
          userId: peer.userId,
          role: peer.role,
          socketId: socket.id,
        });

        await removePeerState(socket.id);
      }
    });

    /**
     * Error handling
     */
    socket.on('error', (error) => {
      logger.error(`WebRTC socket error: ${error.message}`);
    });
  });
}

/**
 * Get list of active peers for a specific exam
 */
export async function getActivePeersInExam(examId: string): Promise<PeerConnectionState[]> {
  return listPeerStatesInExam(examId);
}

/**
 * Get all active students in an exam
 */
export async function getStudentsInExam(examId: string): Promise<PeerConnectionState[]> {
  return (await getActivePeersInExam(examId)).filter((peer) => peer.role === 'STUDENT');
}

/**
 * Get all active faculty in an exam
 */
export async function getFacultyInExam(examId: string): Promise<PeerConnectionState[]> {
  return (await getActivePeersInExam(examId)).filter((peer) => peer.role === 'FACULTY');
}
