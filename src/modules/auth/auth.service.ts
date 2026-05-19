import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import type { JsonWebTokenError } from 'jsonwebtoken';
import { User } from '../../database/schemas/user.schema';
import { Device } from '../../database/schemas/device.schema';
import { RefreshToken } from '../../database/schemas/refresh-token.schema';
import { JWT_CONFIG, SECURITY_CONFIG } from '../../config';
import { IdGenerator, StringUtils } from '../../common/utils/helpers';
import {
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '../../common/exceptions/app.exceptions';
import logger from '../../config/logger';
import { College } from '../../database/schemas/college.schema';

export type StudentProfileExtras = {
  collegeId?: string;
  phoneNumber?: string;
  department?: string;
  branch?: string;
  class?: string;
  division?: string;
  semester?: number;
  batch?: number;
  studentId?: string;
};

export class AuthService {
  private buildLoginResponse(user: any, deviceInfo: any) {
    return (async () => {
      if (user.status !== 'ACTIVE') {
        throw new UnauthorizedException(`User account is ${user.status}`);
      }

      const device = await this.registerDevice(String(user._id), deviceInfo);
      const accessToken = this.generateAccessToken(
        String(user._id),
        user.email,
        user.role,
        device.deviceId
      );
      const refreshToken = await this.issueRefreshToken(String(user._id), device.deviceId);

      user.lastLogin = new Date();
      user.failedLoginAttempts = 0;
      user.lockUntil = undefined;
      await user.save();

      return {
        accessToken,
        refreshToken,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          collegeId: user.collegeId,
          phoneNumber: user.phoneNumber,
          department: user.department,
          branch: user.branch,
          class: user.class,
          division: user.division,
          semester: user.semester,
          batch: user.batch,
          studentId: user.studentId,
        },
      };
    })();
  }

  async register(
    email: string,
    password: string,
    firstName: string,
    lastName: string,
    extras?: StudentProfileExtras
  ) {
    this.assertStrongPassword(password);
    if (!StringUtils.isEmail(String(email || ''))) {
      throw new BadRequestException('Invalid email address');
    }
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new ConflictException('User already exists');
    }

    const studentId = extras?.studentId?.trim();
    if (studentId) {
      const existingStudentId = await User.findOne({ studentId });
      if (existingStudentId) {
        throw new ConflictException('Student ID already exists');
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    let collegeId: string | undefined;
    if (extras?.collegeId) {
      const college = await College.findById(extras.collegeId);
      if (!college || !college.isActive) {
        throw new BadRequestException('Invalid or inactive college');
      }
      collegeId = extras.collegeId;
    }

    // Create user (optional academic/contact fields for students)
    const user = new User({
      email,
      passwordHash,
      firstName,
      lastName,
      role: 'STUDENT',
      status: 'ACTIVE',
      ...(collegeId ? { collegeId } : {}),
      ...(extras?.phoneNumber ? { phoneNumber: extras.phoneNumber.trim() } : {}),
      ...(extras?.department ? { department: extras.department.trim() } : {}),
      ...(extras?.branch ? { branch: extras.branch.trim() } : {}),
      ...(extras?.class ? { class: extras.class.trim() } : {}),
      ...(extras?.division ? { division: extras.division.trim() } : {}),
      ...(extras?.semester != null ? { semester: Number(extras.semester) } : {}),
      ...(extras?.batch != null ? { batch: Number(extras.batch) } : {}),
      ...(studentId ? { studentId } : {}),
    });

    await user.save();
    logger.info(`User registered: ${email}`);

    return { id: user._id, email: user.email, firstName, lastName };
  }

  async login(email: string, password: string, deviceInfo: any) {
    // Find user
    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Account temporarily locked due to failed login attempts');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      await this.recordFailedLogin(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    logger.info(`User logged in: ${email}`);
    return this.buildLoginResponse(user, deviceInfo);
  }

  async loginWithGoogle(idToken: string, deviceInfo: any) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || clientId.includes('REPLACE_WITH_GOOGLE_OAUTH_WEB_CLIENT_ID')) {
      throw new BadRequestException('Google login is not configured');
    }

    const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!tokenInfoResponse.ok) {
      throw new UnauthorizedException('Google login could not be verified');
    }

    const tokenInfo: any = await tokenInfoResponse.json();
    if (tokenInfo.aud !== clientId) {
      throw new UnauthorizedException('Google login client mismatch');
    }
    if (String(tokenInfo.email_verified) !== 'true') {
      throw new UnauthorizedException('Google email is not verified');
    }

    const email = String(tokenInfo.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('You are not registered. Please contact admin.');
    }

    logger.info(`User logged in with Google: ${email}`);
    return this.buildLoginResponse(user, {
      ...deviceInfo,
      fingerprint: deviceInfo?.fingerprint || `google:${tokenInfo.sub}`,
      provider: 'google',
    });
  }

  async loginWithGoogleCode(code: string, redirectUri: string, deviceInfo: any) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || clientId.includes('REPLACE_WITH_GOOGLE_OAUTH_WEB_CLIENT_ID')) {
      throw new BadRequestException('Google login is not configured');
    }
    if (!clientSecret || clientSecret.includes('REPLACE_WITH_GOOGLE_OAUTH_CLIENT_SECRET')) {
      throw new BadRequestException('Google client secret is not configured');
    }
    if (!redirectUri || !redirectUri.startsWith('http://127.0.0.1:')) {
      throw new BadRequestException('Invalid Google redirect URI');
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const tokenPayload: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenPayload.id_token) {
      logger.warn('Google code exchange failed', tokenPayload);
      throw new UnauthorizedException(tokenPayload.error_description || 'Google login could not be completed');
    }

    return this.loginWithGoogle(tokenPayload.id_token, {
      ...deviceInfo,
      fingerprint: deviceInfo?.fingerprint || 'google-desktop-code-flow',
      provider: 'google',
    });
  }

  async registerDevice(userId: string, deviceInfo: any) {
    const deviceId = IdGenerator.generateDeviceId();

    const device = new Device({
      deviceId,
      userId,
      fingerprint: deviceInfo.fingerprint,
      ipAddress: deviceInfo.ipAddress,
      deviceName: deviceInfo.deviceName || 'Unknown Device',
      osType: deviceInfo.osType || 'WINDOWS',
      osVersion: deviceInfo.osVersion,
      browserType: deviceInfo.browserType,
      isVerified: true,
      lastUsed: new Date(),
    });

    await device.save();
    return device;
  }

  private assertStrongPassword(password: string) {
    if (!StringUtils.isStrongPassword(password)) {
      throw new BadRequestException(
        'Password must be at least 8 chars with uppercase, lowercase, number, and special char'
      );
    }
  }

  private async recordFailedLogin(user: any) {
    user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= SECURITY_CONFIG.MAX_LOGIN_ATTEMPTS) {
      user.lockUntil = new Date(Date.now() + SECURITY_CONFIG.LOCKOUT_TIME);
    }
    await user.save();
  }

  private refreshExpiryDate() {
    const value = String(JWT_CONFIG.REFRESH_EXPIRY || '7d');
    const match = value.match(/^(\d+)([smhd])$/i);
    if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() + amount * multipliers[unit]);
  }

  private async issueRefreshToken(userId: string, deviceId: string) {
    const tokenId = IdGenerator.generateUUID();
    const secret = crypto.randomBytes(48).toString('base64url');
    const tokenHash = await bcrypt.hash(secret, 12);

    await RefreshToken.create({
      tokenId,
      userId,
      deviceId,
      tokenHash,
      expiresAt: this.refreshExpiryDate(),
    });

    return `${tokenId}.${secret}`;
  }

  generateAccessToken(userId: string, email: string, role: string, deviceId: string) {
    const accessPayload = { userId, email, role, deviceId };

    const accessOptions: any = {
      expiresIn: JWT_CONFIG.EXPIRY,
      algorithm: 'HS256',
    };

    return jwt.sign(accessPayload, JWT_CONFIG.SECRET as string, accessOptions);
  }

  async refreshToken(refreshToken: string) {
    try {
      const [tokenId, secret] = String(refreshToken || '').split('.');
      if (!tokenId || !secret) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const stored = await RefreshToken.findOne({ tokenId });
      if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const isValid = await bcrypt.compare(secret, stored.tokenHash);
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await User.findById(stored.userId);

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const newRefreshToken = await this.issueRefreshToken(String(user._id), stored.deviceId);
      const newTokenId = newRefreshToken.split('.')[0];
      stored.revokedAt = new Date();
      stored.replacedByTokenId = newTokenId;
      await stored.save();

      const accessToken = this.generateAccessToken(
        String(user._id),
        user.email,
        user.role,
        stored.deviceId
      );

      return { accessToken, refreshToken: newRefreshToken };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, refreshToken?: string, deviceId?: string) {
    logger.info(`User logged out: ${userId}`);
    const now = new Date();
    if (refreshToken) {
      const [tokenId] = String(refreshToken).split('.');
      if (tokenId) {
        await RefreshToken.updateOne({ tokenId, userId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
        return;
      }
    }

    if (deviceId) {
      await RefreshToken.updateMany({ userId, deviceId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
      return;
    }

    await RefreshToken.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
  }
}

export const authService = new AuthService();
