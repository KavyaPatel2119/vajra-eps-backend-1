import { User } from '../../database/schemas/user.schema';
import { Device } from '../../database/schemas/device.schema';
import { AuditLog } from '../../database/schemas/audit-log.schema';
import { College } from '../../database/schemas/college.schema';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '../../common/exceptions/app.exceptions';
import { IdGenerator, StringUtils, ValidationUtils } from '../../common/utils/helpers';
import logger from '../../config/logger';
import bcrypt from 'bcryptjs';

export class UserService {
  async getAllUsers(filter?: any) {
    try {
      const query: any = { isDeleted: false };

      if (filter?.role) {
        query.role = filter.role;
      }

      if (filter?.status) {
        query.status = filter.status;
      }

      if (filter?.collegeId) {
        query.collegeId = filter.collegeId;
      }

      if (filter?.department) {
        query.department = filter.department;
      }

      if (filter?.branch) {
        query.branch = filter.branch;
      }

      if (filter?.class) {
        query.class = filter.class;
      }

      if (filter?.division) {
        query.division = filter.division;
      }

      if (filter?.semester) {
        query.semester = Number(filter.semester);
      }

      if (filter?.batch) {
        query.batch = Number(filter.batch);
      }

      if (filter?.studentId) {
        query.studentId = filter.studentId;
      }
      if (filter?.facultyId) {
        query.facultyId = filter.facultyId;
      }

      const users = await User.find(query)
        .select('-passwordHash')
        .populate('collegeId')
        .limit(filter?.limit || 50)
        .skip(filter?.skip || 0)
        .sort({ createdAt: -1 });

      const total = await User.countDocuments(query);

      return { users, total };
    } catch (error) {
      logger.error('Failed to fetch users:', error);
      throw error;
    }
  }

  async getUserById(userId: string) {
    try {
      const user = await User.findById(userId).select('-passwordHash').populate('collegeId');

      if (!user || user.isDeleted) {
        throw new NotFoundException('User not found');
      }

      return user;
    } catch (error) {
      logger.error('Failed to fetch user:', error);
      throw error;
    }
  }

  async updateUserProfile(
    userId: string,
    updates: any,
    requestMeta?: { ipAddress?: string; userAgent?: string }
  ) {
    try {
      const user = await User.findById(userId);

      if (!user || user.isDeleted) {
        throw new NotFoundException('User not found');
      }

      // Allow updating firstName, lastName, email
      if (updates.firstName) user.firstName = StringUtils.sanitize(updates.firstName);
      if (updates.lastName) user.lastName = StringUtils.sanitize(updates.lastName);
      if (updates.phoneNumber !== undefined) {
        user.phoneNumber = updates.phoneNumber ? StringUtils.sanitize(updates.phoneNumber) : undefined;
      }
      if (updates.department !== undefined) {
        user.department = updates.department ? StringUtils.sanitize(updates.department) : undefined;
      }
      if (updates.branch !== undefined) {
        user.branch = updates.branch ? StringUtils.sanitize(updates.branch) : undefined;
      }
      if (updates.class !== undefined) {
        user.class = updates.class ? StringUtils.sanitize(updates.class) : undefined;
      }
      if (updates.division !== undefined) {
        user.division = updates.division ? StringUtils.sanitize(updates.division) : undefined;
      }
      if (updates.semester !== undefined) {
        const semester = Number(updates.semester);
        user.semester = Number.isFinite(semester) ? semester : undefined;
      }
      if (updates.batch !== undefined) {
        const batch = Number(updates.batch);
        user.batch = Number.isFinite(batch) ? batch : undefined;
      }
      if (updates.studentId !== undefined && user.role === 'STUDENT') {
        const nextStudentId = updates.studentId ? StringUtils.sanitize(updates.studentId) : undefined;
        if (nextStudentId && nextStudentId !== user.studentId) {
          const existingStudentId = await User.findOne({ studentId: nextStudentId, _id: { $ne: user._id } });
          if (existingStudentId) {
            throw new ConflictException('Student ID already exists');
          }
        }
        user.studentId = nextStudentId;
      }
      if (updates.facultyId !== undefined && user.role === 'FACULTY') {
        user.facultyId = updates.facultyId ? StringUtils.sanitize(updates.facultyId) : undefined;
      }

      // Email change requires verification (not implemented in Phase 1)
      if (updates.email && updates.email !== user.email) {
        const existing = await User.findOne({ email: updates.email });
        if (existing) {
          throw new ConflictException('Email already in use');
        }
        user.email = updates.email;
      }

      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId,
        action: 'UPDATE_PROFILE',
        resourceType: 'User',
        resourceId: userId,
        ipAddress: requestMeta?.ipAddress || 'unknown',
        userAgent: requestMeta?.userAgent || 'unknown',
        changes: [
          {
            field: 'firstName',
            oldValue: user.firstName,
            newValue: updates.firstName,
          },
          {
            field: 'lastName',
            oldValue: user.lastName,
            newValue: updates.lastName,
          },
        ],
        status: 'SUCCESS',
      });

      return user;
    } catch (error) {
      logger.error('Failed to update user profile:', error);
      throw error;
    }
  }

  async createFacultyUser(payload: any, creatorId: string) {
    try {
      const { email, password, firstName, lastName, collegeId, facultyId } = payload;

      if (!email || !password || !firstName || !lastName || !collegeId) {
        throw new BadRequestException('Email, password, firstName, lastName, and collegeId are required');
      }
      if (!StringUtils.isStrongPassword(password)) {
        throw new BadRequestException(
          'Password must be at least 8 chars with uppercase, lowercase, number, and special char'
        );
      }

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        throw new ConflictException('User already exists');
      }
      if (facultyId) {
        const existingFacultyId = await User.findOne({ facultyId: String(facultyId).trim() });
        if (existingFacultyId) {
          throw new ConflictException('Faculty ID already exists');
        }
      }

      const college = await College.findById(collegeId);
      if (!college || !college.isActive) {
        throw new NotFoundException('College not found');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const faculty = new User({
        email,
        passwordHash,
        firstName,
        lastName,
        role: 'FACULTY',
        status: 'ACTIVE',
        collegeId,
        facultyId: facultyId ? StringUtils.sanitize(String(facultyId)) : String(email).split('@')[0],
      });

      await faculty.save();

      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: creatorId,
        action: 'CREATE_FACULTY',
        resourceType: 'User',
        resourceId: faculty._id,
        changes: [
          {
            field: 'collegeId',
            oldValue: '',
            newValue: collegeId,
          },
        ],
        status: 'SUCCESS',
      });

      return User.findById(faculty._id).select('-passwordHash').populate('collegeId');
    } catch (error) {
      logger.error('Failed to create faculty user:', error);
      throw error;
    }
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    try {
      if (!StringUtils.isStrongPassword(newPassword)) {
        throw new BadRequestException(
          'Password must be at least 8 chars with uppercase, lowercase, number, and special char'
        );
      }

      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const isValid = await bcrypt.compare(oldPassword, user.passwordHash);

      if (!isValid) {
        throw new ForbiddenException('Incorrect current password');
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      user.passwordHash = newHash;
      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId,
        action: 'CHANGE_PASSWORD',
        resourceType: 'User',
        resourceId: userId,
        status: 'SUCCESS',
      });

      logger.info(`✅ Password changed for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to change password:', error);
      throw error;
    }
  }

  async verifyDevice(userId: string, deviceId: string) {
    try {
      const device = await Device.findOne({ deviceId, userId });

      if (!device) {
        throw new NotFoundException('Device not found');
      }

      device.isVerified = true;
      await device.save();

      logger.info(`✅ Device ${deviceId} verified for user ${userId}`);
      return device;
    } catch (error) {
      logger.error('Failed to verify device:', error);
      throw error;
    }
  }

  async getDevices(userId: string) {
    try {
      const devices = await Device.find({ userId }).sort({ lastUsed: -1 });
      return devices;
    } catch (error) {
      logger.error('Failed to fetch devices:', error);
      throw error;
    }
  }

  async removeDevice(userId: string, deviceId: string) {
    try {
      const result = await Device.deleteOne({ deviceId, userId });

      if (result.deletedCount === 0) {
        throw new NotFoundException('Device not found');
      }

      logger.info(`✅ Device ${deviceId} removed for user ${userId}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to remove device:', error);
      throw error;
    }
  }

  async softDeleteUser(userId: string) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      user.isDeleted = true;
      user.status = 'INACTIVE';
      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: 'SYSTEM',
        action: 'DELETE_USER',
        resourceType: 'User',
        resourceId: userId,
        status: 'SUCCESS',
      });

      logger.info(`✅ User ${userId} soft deleted`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete user:', error);
      throw error;
    }
  }

  async updateUserRole(userId: string, newRole: string, facultyId: string) {
    try {
      const validRoles = ['STUDENT', 'FACULTY'];

      if (!validRoles.includes(newRole)) {
        throw new BadRequestException('Invalid role');
      }

      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const oldRole = user.role;
      user.role = newRole as 'STUDENT' | 'FACULTY';
      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: facultyId,
        action: 'UPDATE_USER_ROLE',
        resourceType: 'User',
        resourceId: userId,
        changes: [
          {
            field: 'role',
            oldValue: oldRole,
            newValue: newRole,
          },
        ],
        status: 'SUCCESS',
      });

      logger.info(`✅ User ${userId} role changed to ${newRole}`);
      return user;
    } catch (error) {
      logger.error('Failed to update user role:', error);
      throw error;
    }
  }

  async suspendUser(userId: string, reason: string, facultyId: string) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      user.status = 'SUSPENDED';
      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: facultyId,
        action: 'SUSPEND_USER',
        resourceType: 'User',
        resourceId: userId,
        changes: [
          {
            field: 'reason',
            oldValue: '',
            newValue: reason,
          },
        ],
        status: 'SUCCESS',
      });

      logger.info(`✅ User ${userId} suspended: ${reason}`);
      return user;
    } catch (error) {
      logger.error('Failed to suspend user:', error);
      throw error;
    }
  }

  async reactivateUser(userId: string, facultyId: string) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      user.status = 'ACTIVE';
      await user.save();

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: facultyId,
        action: 'REACTIVATE_USER',
        resourceType: 'User',
        resourceId: userId,
        status: 'SUCCESS',
      });

      logger.info(`✅ User ${userId} reactivated`);
      return user;
    } catch (error) {
      logger.error('Failed to reactivate user:', error);
      throw error;
    }
  }
}
