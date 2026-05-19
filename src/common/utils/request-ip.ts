import type { Request } from 'express';

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeIp(ip?: string | null) {
  const raw = String(ip || '').trim();
  if (!raw) return 'unknown';

  const first = raw.split(',')[0].trim();
  if (!first) return 'unknown';

  if (first.startsWith('::ffff:')) return first.slice('::ffff:'.length);
  if (first === '::1') return '127.0.0.1';
  return first;
}

export function getRequestIp(req: Request) {
  return normalizeIp(
    firstHeaderValue(req.headers['x-forwarded-for']) ||
      firstHeaderValue(req.headers['x-real-ip']) ||
      firstHeaderValue(req.headers['cf-connecting-ip']) ||
      firstHeaderValue(req.headers['true-client-ip']) ||
      req.ip ||
      req.socket.remoteAddress
  );
}
