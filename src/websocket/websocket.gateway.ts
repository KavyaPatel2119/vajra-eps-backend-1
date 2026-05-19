import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { SurveillanceService } from '../modules/surveillance/surveillance.service';
import { UFMService } from '../modules/ufm/ufm.service';
import logger from '../config/logger';

const surveillanceService = new SurveillanceService();
const ufmService = new UFMService();

export class WebSocketGateway {
  private io: SocketIOServer;
  private activeSessions = new Map();

  constructor(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  private setupMiddleware() {
    this.io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      // TODO: Validate JWT token
      next();
    });
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: Socket) => {
      logger.info(`🔗 WebSocket connected: ${socket.id}`);

      // SURVEILLANCE EVENT
      socket.on('surveillance:activity', (data) => {
        this.handleSurveillanceActivity(socket, data);
      });

      // EXAM EVENT: Session started
      socket.on('exam:session-start', (data) => {
        this.activeSessions.set(data.sessionId, {
          studentId: data.studentId,
          examId: data.examId,
          socketId: socket.id,
          startTime: Date.now(),
        });
        logger.debug(`📊 Session started: ${data.sessionId}`);
      });

      // EXAM EVENT: Answer submitted
      socket.on('exam:answer-saved', (data) => {
        logger.debug(`💾 Answer saved: ${data.questionId}`);
      });

      // EXAM EVENT: Session ended
      socket.on('exam:session-end', (data) => {
        this.activeSessions.delete(data.sessionId);
        logger.debug(`🏁 Session ended: ${data.sessionId}`);
      });

      // UFM EVENT: Unfair means detected
      socket.on('ufm:detected', async (data) => {
        await this.handleUFMDetected(socket, data);
      });

      // HEARTBEAT
      socket.on('heartbeat', (data) => {
        socket.emit('heartbeat:ack', { timestamp: Date.now() });
      });

      // DISCONNECT
      socket.on('disconnect', () => {
        logger.info(`🔌 WebSocket disconnected: ${socket.id}`);
        // Clean up active sessions
        for (const [sessionId, session] of this.activeSessions.entries()) {
          if (session.socketId === socket.id) {
            this.activeSessions.delete(sessionId);
          }
        }
      });
    });
  }

  private async handleSurveillanceActivity(socket: Socket, data: any) {
    try {
      const log = await surveillanceService.createLog(data);

      // Notify faculty monitoring this exam
      this.io.to(`exam:${data.examId}`).emit('surveillance:activity-logged', {
        logId: log.logId,
        studentId: data.studentId,
        eventType: data.eventType,
        severity: data.severity,
        timestamp: new Date(),
      });

      logger.debug(`📹 Surveillance activity logged: ${data.eventType}`);
    } catch (error) {
      logger.error('Failed to log surveillance activity:', error);
      socket.emit('error', { message: 'Failed to log activity' });
    }
  }

  private async handleUFMDetected(socket: Socket, data: any) {
    try {
      const report = await ufmService.createUFMReport(data);

      // Notify student of UFM detection
      socket.emit('ufm:confirmed', {
        ufmId: report.ufmId,
        reason: report.reason,
        severity: report.severity,
      });

      // Notify faculty monitoring this exam
      this.io.to(`exam:${data.examId}`).emit('ufm:detected-alert', {
        ufmId: report.ufmId,
        studentId: data.studentId,
        severity: report.severity,
        reasons: report.reason,
      });

      logger.warn(`⚠️  UFM detected: ${report.ufmId}`);
    } catch (error) {
      logger.error('Failed to handle UFM detection:', error);
      socket.emit('error', { message: 'Failed to process UFM' });
    }
  }

  // JOIN exam room for monitoring
  public joinExamMonitoring(socket: Socket, examId: string) {
    socket.join(`exam:${examId}`);
    logger.debug(`📡 Socket joined exam:${examId}`);
  }

  // LEAVE exam room
  public leaveExamMonitoring(socket: Socket, examId: string) {
    socket.leave(`exam:${examId}`);
    logger.debug(`📡 Socket left exam:${examId}`);
  }

  // BROADCAST to all clients in exam
  public broadcastToExam(examId: string, event: string, data: any) {
    this.io.to(`exam:${examId}`).emit(event, data);
  }

  // SEND to specific socket
  public sendToSocket(socketId: string, event: string, data: any) {
    this.io.to(socketId).emit(event, data);
  }

  getIO() {
    return this.io;
  }

  getActiveSessions() {
    return this.activeSessions;
  }
}
