import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_CONFIG } from '../config';
import { UnauthorizedException } from '../common/exceptions/app.exceptions';
import { JwtPayload, AuthUser } from '../common/types';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_CONFIG.SECRET) as JwtPayload;

    req.user = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      deviceId: decoded.deviceId,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        status: 'ERROR',
        statusCode: 401,
        message: 'Token expired',
        errorCode: 'TOKEN_EXPIRED',
      });
    }
    res.status(401).json({
      status: 'ERROR',
      statusCode: 401,
      message: 'Invalid token',
      errorCode: 'INVALID_TOKEN',
    });
  }
};
