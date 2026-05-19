import { Request, Response, NextFunction } from 'express';
import { ResponseFormatter } from '../common/utils/response.formatter';
import logger from '../config/logger';

export const errorMiddleware = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('Error:', error);

  // AppException
  if (error.statusCode && error.errorCode) {
    return res.status(error.statusCode).json(
      ResponseFormatter.error(error.message, error.statusCode, {
        errorCode: error.errorCode,
      })
    );
  }

  // Validation Error
  if (error.errors && Array.isArray(error.errors)) {
    const errors: Record<string, string> = {};
    error.errors.forEach((err: any) => {
      errors[err.param] = err.msg;
    });
    return res.status(422).json(
      ResponseFormatter.error('Validation failed', 422, errors)
    );
  }

  // MongoDB errors
  if (error.name === 'MongoServerError') {
    if (error.code === 11000 && error.keyValue && typeof error.keyValue === 'object') {
      const keys = Object.keys(error.keyValue);
      const field = keys[0] || 'field';
      return res.status(409).json(
        ResponseFormatter.error(`${field} already exists`, 409)
      );
    }
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json(
      ResponseFormatter.error('Invalid token', 401)
    );
  }

  // Default error
  res.status(error.statusCode || 500).json(
    ResponseFormatter.error(
      error.message || 'Internal server error',
      error.statusCode || 500
    )
  );
};
