import 'dotenv/config';
import 'express-async-errors';
import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

import { connectDatabase, disconnectDatabase } from './config/database';
import logger from './config/logger';
import { APP_CONFIG } from './config';
import { setupWebRTCHandlers } from './handlers/webrtcHandler';
import { setupTeacherCommandHandlers } from './handlers/teacherCommandHandler';
import { setupExamSocketHandlers } from './handlers/examSocketHandler';
import { attachSocketHub } from './realtime/socket-hub';
import { setupSocketAuth } from './middleware/socket-auth.middleware';
import { setupRedisSocketAdapter } from './realtime/redis-adapter';

// Middleware
import { errorMiddleware } from './middleware/error.middleware';
import { requestLoggingMiddleware } from './middleware/logging.middleware';
import { securityMiddlewares } from './middleware/security.middleware';
import { globalLimiter } from './middleware/rate-limit.middleware';

// Routes
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import examRoutes from './modules/exams/exam.routes';
import sessionRoutes from './modules/sessions/session.routes';
import resultRoutes from './modules/results/result.routes';
import ufmRoutes from './modules/ufm/ufm.routes';
import surveillanceRoutes from './modules/surveillance/surveillance.routes';
import collegeRoutes from './modules/colleges/college.routes';
import aiRoutes from './modules/ai/ai.routes';
import uploadRoutes from './modules/upload/upload.routes';
import jobRoutes from './modules/jobs/job.routes';
import webrtcRoutes from './modules/webrtc/webrtc.routes';
import { queueService } from './queues/queue.service';

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

const parseOrigins = (value?: string) =>
  (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const corsOrigins = parseOrigins(process.env.CORS_ORIGIN);
const socketCorsOrigins = parseOrigins(process.env.SOCKET_IO_CORS_ORIGIN);
const corsCredentials = (process.env.CORS_CREDENTIALS || 'false').toLowerCase() === 'true';
const socketTransports = parseOrigins(process.env.SOCKET_IO_TRANSPORTS) as Array<'websocket' | 'polling'>;

let databaseConnected = false;
let localHttpServer: any = null;
let localSocketServer: SocketIOServer | null = null;

async function ensureDatabaseConnection() {
  if (databaseConnected) return;
  await connectDatabase();
  databaseConnected = true;
}

export function createApp() {
  const app = express();
  app.set('trust proxy', APP_CONFIG.NODE_ENV === 'test' ? false : true);

  // Security
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow non-browser clients (no Origin header), Electron file:// flows, and server-to-server calls.
        if (!origin) return callback(null, true);
        if (corsOrigins.length === 0 || corsOrigins.includes('*') || corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: corsCredentials,
    })
  );
  app.use(compression());
  app.use(globalLimiter);
  app.use(...securityMiddlewares);

  // Logging
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  }
  app.use(requestLoggingMiddleware);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  logger.info('✅ Middleware configured');

  // Health check
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      version: APP_CONFIG.VERSION,
    });
  });

  // API routes
  const apiV1 = '/api/v1';

  // Auth routes (with rate limiting)
  app.use(`${apiV1}/auth`, authRoutes);

  // Protected routes
  app.use(`${apiV1}/users`, userRoutes);
  app.use(`${apiV1}/exams`, examRoutes);
  app.use(`${apiV1}/sessions`, sessionRoutes);
  app.use(`${apiV1}/results`, resultRoutes);
  app.use(`${apiV1}/ufm`, ufmRoutes);
  app.use(`${apiV1}/surveillance`, surveillanceRoutes);
  app.use(`${apiV1}/colleges`, collegeRoutes);

  // New routes: AI & Upload
  app.use(`${apiV1}/ai`, aiRoutes);
  app.use(`${apiV1}/upload`, uploadRoutes);
  app.use(`${apiV1}/jobs`, jobRoutes);
  app.use(`${apiV1}/webrtc`, webrtcRoutes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      status: 'ERROR',
      statusCode: 404,
      message: 'Route not found',
    });
  });

  app.use(errorMiddleware);

  logger.info('✅ Routes configured');
  return app;
}

async function startLocalServer() {
  await ensureDatabaseConnection();

  const app = createApp();
  localHttpServer = createServer(app);

  localSocketServer = new SocketIOServer(localHttpServer, {
    cors: {
      origin:
        socketCorsOrigins.length === 0 || socketCorsOrigins.includes('*')
          ? true
          : socketCorsOrigins,
      methods: ['GET', 'POST'],
      credentials: corsCredentials,
    },
    transports: socketTransports.length > 0 ? socketTransports : ['websocket', 'polling'],
  });

  await setupRedisSocketAdapter(localSocketServer);
  setupSocketAuth(localSocketServer);
  setupWebRTCHandlers(localSocketServer);
  setupTeacherCommandHandlers(localSocketServer);
  setupExamSocketHandlers(localSocketServer);
  attachSocketHub(localSocketServer);
  queueService.startWorker();

  localSocketServer.on('connection', (socket) => {
    logger.info(`WebSocket connected: ${socket.id}`);

    socket.on('disconnect', () => {
      logger.info(`WebSocket disconnected: ${socket.id}`);
    });
  });

  localHttpServer.listen(APP_CONFIG.PORT, () => {
    logger.info(`✅ ${APP_CONFIG.NAME} server running on port ${APP_CONFIG.PORT}`);
    logger.info(`Environment: ${APP_CONFIG.NODE_ENV}`);
  });
}

export class VajraServer {
  private app: Express;

  constructor() {
    this.app = createApp();
  }

  getApp() {
    return this.app;
  }

  async stop() {
    await disconnectDatabase().catch(() => undefined);
  }
}

async function vercelHandler(req: express.Request, res: express.Response) {
  await ensureDatabaseConnection();
  const app = createApp();
  return app(req, res);
}

if (!isVercel && APP_CONFIG.NODE_ENV !== 'test') {
  void startLocalServer();

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received');
    if (localHttpServer) {
      localHttpServer.close();
    }
    await disconnectDatabase();
    logger.info('Server stopped');
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received');
    if (localHttpServer) {
      localHttpServer.close();
    }
    await disconnectDatabase();
    logger.info('Server stopped');
  });
}

export default vercelHandler;
