import winston from 'winston';
import fs from 'fs';
import path from 'path';

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const logsDir = path.resolve(process.cwd(), 'logs');

const canWriteFiles = !isVercel;

if (canWriteFiles) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // Ignore directory creation failures and fall back to console logging only.
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'vajra-eps-backend' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} [${level}]: ${message}`;
        })
      ),
    }),
    ...(canWriteFiles
      ? [
          // Error logs
          new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
          }),
          // Combined logs
          new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
          }),
        ]
      : []),
  ],
});

export default logger;
