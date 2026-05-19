export interface ApiResponse<T = any> {
  status: 'SUCCESS' | 'ERROR';
  statusCode: number;
  data?: T;
  message?: string;
  errors?: Record<string, any>;
  timestamp: string;
}

export class ResponseFormatter {
  static success<T>(data: T, statusCode = 200): ApiResponse<T> {
    return {
      status: 'SUCCESS',
      statusCode,
      data,
      timestamp: new Date().toISOString(),
    };
  }

  static error(message: string, statusCode = 500, errors?: Record<string, any>): ApiResponse {
    return {
      status: 'ERROR',
      statusCode,
      message,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  static paginated<T>(
    data: T[],
    page: number,
    limit: number,
    total: number,
    statusCode = 200
  ) {
    return {
      status: 'SUCCESS',
      statusCode,
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
