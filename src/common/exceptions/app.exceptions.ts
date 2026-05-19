export class AppException extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errorCode: string
  ) {
    super(message);
    Object.setPrototypeOf(this, AppException.prototype);
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenException extends AppException {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

export class NotFoundException extends AppException {
  constructor(resource: string) {
    super(404, `${resource} not found`, 'NOT_FOUND');
  }
}

export class BadRequestException extends AppException {
  constructor(message: string) {
    super(400, message, 'BAD_REQUEST');
  }
}

export class ConflictException extends AppException {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class InternalServerException extends AppException {
  constructor(message = 'Internal server error') {
    super(500, message, 'INTERNAL_SERVER_ERROR');
  }
}

export class ConcurrentLoginException extends AppException {
  constructor() {
    super(409, 'Concurrent login detected', 'CONCURRENT_LOGIN_UFM');
  }
}

export class DeviceNotVerifiedException extends AppException {
  constructor() {
    super(403, 'Device not verified', 'DEVICE_NOT_VERIFIED');
  }
}

export class RateLimitExceededException extends AppException {
  constructor() {
    super(429, 'Too many requests', 'RATE_LIMIT_EXCEEDED');
  }
}

export class ValidationException extends AppException {
  constructor(public errors: Record<string, string>) {
    super(422, 'Validation failed', 'VALIDATION_ERROR');
  }
}
