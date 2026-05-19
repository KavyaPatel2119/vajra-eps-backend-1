import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_CONFIG } from '../config';

export const loginLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.WINDOW_MS,
  max: RATE_LIMIT_CONFIG.LOGIN_LIMIT,
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: any) => process.env.NODE_ENV === 'test',
});

export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.WINDOW_MS,
  max: RATE_LIMIT_CONFIG.API_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
});

export const globalLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.WINDOW_MS,
  max: RATE_LIMIT_CONFIG.GLOBAL_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
});
