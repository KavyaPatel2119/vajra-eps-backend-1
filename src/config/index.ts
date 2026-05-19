export const JWT_CONFIG = {
  SECRET: requireSecret('JWT_SECRET', process.env.JWT_SECRET),
  REFRESH_SECRET: requireSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET),
  EXPIRY: process.env.JWT_EXPIRY || '15m',
  REFRESH_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY || '7d',
};

function requireSecret(name: string, value?: string) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('change-in-production') || normalized.length < 32) {
    throw new Error(`${name} must be set to a strong secret of at least 32 characters`);
  }
  return normalized;
}

export const SECURITY_CONFIG = {
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_TIME: 15 * 60 * 1000, // 15 minutes
  SESSION_TIMEOUT: parseInt(process.env.SESSION_TIMEOUT || '3600') * 1000, // 1 hour
  MAX_CONCURRENT_DEVICES: parseInt(process.env.MAX_CONCURRENT_DEVICES || '1'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

export const RATE_LIMIT_CONFIG = {
  WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  LOGIN_LIMIT: 5, // 5 requests per window
  API_LIMIT: 100, // 100 requests per window
  GLOBAL_LIMIT: 1000, // 1000 requests per window
};

export const APP_CONFIG = {
  NAME: process.env.APP_NAME || 'VAJRA EPS',
  VERSION: process.env.APP_VERSION || '1.0.0',
  PORT: parseInt(process.env.PORT || '3000'),
  NODE_ENV: process.env.NODE_ENV || 'development',
};

export const AWS_CONFIG = {
  REGION: process.env.AWS_REGION || 'us-east-1',
  ACCESS_KEY: process.env.AWS_ACCESS_KEY_ID,
  SECRET_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  S3_BUCKET: process.env.AWS_S3_BUCKET || 'vajra-eps-local',
};
