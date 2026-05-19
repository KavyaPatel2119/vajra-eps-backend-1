import { Request, Response, NextFunction } from 'express';
import { ForbiddenException } from '../common/exceptions/app.exceptions';

export const rbacMiddleware = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new ForbiddenException('User not authenticated');
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenException(
        `This action requires one of these roles: ${allowedRoles.join(', ')}`
      );
    }

    next();
  };
};
