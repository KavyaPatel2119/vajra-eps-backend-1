import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

function splitUrls(value?: string) {
  return String(value || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

function buildIceServers() {
  const iceServers: Array<Record<string, unknown>> = [];
  const stunUrls = splitUrls(process.env.WEBRTC_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302');
  const turnUrls = splitUrls(process.env.WEBRTC_TURN_URLS || process.env.TURN_URLS);
  const turnUsername = process.env.WEBRTC_TURN_USERNAME || process.env.TURN_USERNAME;
  const turnCredential =
    process.env.WEBRTC_TURN_CREDENTIAL ||
    process.env.WEBRTC_TURN_PASSWORD ||
    process.env.TURN_CREDENTIAL ||
    process.env.TURN_PASSWORD;

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return iceServers;
}

router.get('/ice-config', authMiddleware, (_req: Request, res: Response) => {
  res.json({
    status: 'SUCCESS',
    data: {
      iceServers: buildIceServers(),
      ttlSeconds: Number(process.env.WEBRTC_ICE_TTL_SECONDS || 3600),
    },
  });
});

export default router;
