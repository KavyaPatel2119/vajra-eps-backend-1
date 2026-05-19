export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  deviceId: string;
  iat: number;
  exp: number;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  deviceId: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  deviceInfo: {
    deviceId: string;
    fingerprint: string;
    ipAddress: string;
    userAgent: string;
  };
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  };
}

export interface ExamSession {
  sessionId: string;
  examId: string;
  studentId: string;
  startTime: Date;
  expiresAt: Date;
  status: string;
}
