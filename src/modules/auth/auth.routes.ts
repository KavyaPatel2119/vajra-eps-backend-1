import { Router, Request, Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { loginLimiter } from '../../middleware/rate-limit.middleware';
import { authMiddleware } from '../../middleware/auth.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { getRequestIp } from '../../common/utils/request-ip';

const router = Router();

// POST /api/v1/auth/register
router.post('/register', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      collegeId,
      phoneNumber,
      department,
      branch,
      class: className,
      division,
      semester,
      batch,
      studentId,
    } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json(
        ResponseFormatter.error('Missing required fields', 400)
      );
    }

    const user = await authService.register(email, password, firstName, lastName, {
      collegeId,
      phoneNumber,
      department,
      branch,
      class: className,
      division,
      semester: semester != null ? Number(semester) : undefined,
      batch: batch != null ? Number(batch) : undefined,
      studentId,
    });
    res.status(201).json(ResponseFormatter.success(user, 201));
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, deviceInfo } = req.body;

    if (!email || !password || !deviceInfo) {
      return res.status(400).json(
        ResponseFormatter.error('Missing required fields', 400)
      );
    }

    const requestDeviceInfo = {
      ...(deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : {}),
      ipAddress: getRequestIp(req),
      userAgent: deviceInfo?.userAgent || req.get('user-agent') || 'unknown',
    };

    const result = await authService.login(email, password, requestDeviceInfo);
    res.status(200).json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/google
router.post('/google', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { credential, deviceInfo } = req.body;

    if (!credential || !deviceInfo) {
      return res.status(400).json(
        ResponseFormatter.error('Missing required fields', 400)
      );
    }

    const requestDeviceInfo = {
      ...(deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : {}),
      ipAddress: getRequestIp(req),
      userAgent: deviceInfo?.userAgent || req.get('user-agent') || 'unknown',
    };

    const result = await authService.loginWithGoogle(String(credential), requestDeviceInfo);
    res.status(200).json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/google/code
router.post('/google/code', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, redirectUri, deviceInfo } = req.body;

    if (!code || !redirectUri || !deviceInfo) {
      return res.status(400).json(
        ResponseFormatter.error('Missing required fields', 400)
      );
    }

    const requestDeviceInfo = {
      ...(deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : {}),
      ipAddress: getRequestIp(req),
      userAgent: deviceInfo?.userAgent || req.get('user-agent') || 'unknown',
    };

    const result = await authService.loginWithGoogleCode(String(code), String(redirectUri), requestDeviceInfo);
    res.status(200).json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json(
        ResponseFormatter.error('Refresh token required', 400)
      );
    }

    const tokens = await authService.refreshToken(refreshToken);
    res.status(200).json(ResponseFormatter.success(tokens));
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/logout
router.post('/logout', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json(ResponseFormatter.error('Unauthorized', 401));
    }

    await authService.logout(req.user.id, req.body?.refreshToken, req.user.deviceId);
    res.status(200).json(ResponseFormatter.success({ message: 'Logged out successfully' }));
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/auth/me
router.get('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json(ResponseFormatter.error('Unauthorized', 401));
    }

    res.status(200).json(ResponseFormatter.success({
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
    }));
  } catch (error) {
    next(error);
  }
});

export default router;
