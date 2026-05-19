import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export class IdGenerator {
  static generateUUID(): string {
    return uuidv4();
  }

  static generateExamId(): string {
    return `EXAM_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  static generateSessionId(): string {
    return `SESSION_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  static generateUserId(): string {
    return `USER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  static generateUFMId(): string {
    return `UFM_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  static generateDeviceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}

export class DateUtils {
  static addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60000);
  }

  static addHours(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 3600000);
  }

  static addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 86400000);
  }

  static isExpired(date: Date): boolean {
    return new Date() > date;
  }

  static getRemainingTime(expiresAt: Date): number {
    return Math.max(0, expiresAt.getTime() - new Date().getTime());
  }
}

export class StringUtils {
  static isEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static isStrongPassword(password: string): boolean {
    // At least 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
    const passwordRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return passwordRegex.test(password);
  }

  static sanitize(input: string): string {
    return input.trim().replace(/[<>\"']/g, '');
  }
}

export class ValidationUtils {
  static validateExamDuration(duration: number): boolean {
    return duration > 0 && duration <= 480; // Max 8 hours
  }

  static validateMarks(obtained: number, total: number): boolean {
    return obtained >= 0 && obtained <= total;
  }

  static calculatePercentage(obtained: number, total: number): number {
    if (total === 0) return 0;
    return Math.round((obtained / total) * 100);
  }

  static getGrade(percentage: number): string {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B';
    if (percentage >= 60) return 'C';
    if (percentage >= 50) return 'D';
    return 'F';
  }
}

export class ArrayUtils {
  static chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  static shuffle<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  static removeDuplicates<T>(array: T[]): T[] {
    return [...new Set(array)];
  }
}
