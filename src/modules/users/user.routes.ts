import { Router, Request, Response, NextFunction } from 'express';
import { UserService } from './user.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { BadRequestException } from '../../common/exceptions/app.exceptions';
import logger from '../../config/logger';

const router = Router();
const userService = new UserService();

// GET all users (FACULTY only)
router.get('/', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      role: req.query.role,
      status: req.query.status,
      collegeId: req.query.collegeId,
      department: req.query.department,
      branch: req.query.branch,
      class: req.query.class,
      division: req.query.division,
      semester: req.query.semester,
      batch: req.query.batch,
      studentId: req.query.studentId,
      facultyId: req.query.facultyId,
      limit: parseInt(req.query.limit as string) || 50,
      skip: parseInt(req.query.skip as string) || 0,
    };

    const result = await userService.getAllUsers(filter);
    res.json(ResponseFormatter.paginated(result.users, 1, filter.limit, result.total));
  } catch (error) {
    next(error);
  }
});

// GET current user
router.get('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.getUserById(req.user!.id);
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// CREATE faculty user (FACULTY only)
router.post('/faculty', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const createdUser = await userService.createFacultyUser(req.body, req.user!.id);
    res.status(201).json(ResponseFormatter.success(createdUser, 201));
  } catch (error) {
    next(error);
  }
});

// GET user by ID
router.get('/:userId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role === 'STUDENT' && req.user!.id !== req.params.userId) {
      throw new BadRequestException('Unauthorized');
    }
    const user = await userService.getUserById(req.params.userId);
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// UPDATE user profile
router.put('/:userId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Users can only update their own profile, faculty can update others
    if (req.user!.id !== req.params.userId && req.user!.role !== 'FACULTY') {
      throw new BadRequestException('Unauthorized');
    }

    const user = await userService.updateUserProfile(req.params.userId, req.body, {
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.get('user-agent') || 'unknown',
    });
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// CHANGE password
router.post('/:userId/change-password', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.id !== req.params.userId) {
      throw new BadRequestException('Can only change your own password');
    }

    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      throw new BadRequestException('Old and new passwords required');
    }

    await userService.changePassword(req.params.userId, oldPassword, newPassword);
    res.json(ResponseFormatter.success({ message: 'Password changed successfully' }));
  } catch (error) {
    next(error);
  }
});

// GET user devices
router.get('/:userId/devices', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.id !== req.params.userId && req.user!.role !== 'FACULTY') {
      throw new BadRequestException('Unauthorized');
    }

    const devices = await userService.getDevices(req.params.userId);
    res.json(ResponseFormatter.success(devices));
  } catch (error) {
    next(error);
  }
});

// VERIFY device
router.post('/:userId/devices/:deviceId/verify', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.id !== req.params.userId && req.user!.role !== 'FACULTY') {
      throw new BadRequestException('Unauthorized');
    }
    const device = await userService.verifyDevice(req.params.userId, req.params.deviceId);
    res.json(ResponseFormatter.success(device));
  } catch (error) {
    next(error);
  }
});

// REMOVE device
router.delete('/:userId/devices/:deviceId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.id !== req.params.userId && req.user!.role !== 'FACULTY') {
      throw new BadRequestException('Unauthorized');
    }

    await userService.removeDevice(req.params.userId, req.params.deviceId);
    res.json(ResponseFormatter.success({ message: 'Device removed' }));
  } catch (error) {
    next(error);
  }
});

// UPDATE user role (FACULTY only)
router.put('/:userId/role', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { role } = req.body;

    if (!role) {
      throw new BadRequestException('Role required');
    }

    const user = await userService.updateUserRole(req.params.userId, role, req.user!.id);
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// SUSPEND user (FACULTY only)
router.post('/:userId/suspend', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      throw new BadRequestException('Suspension reason required');
    }

    const user = await userService.suspendUser(req.params.userId, reason, req.user!.id);
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// REACTIVATE user (FACULTY only)
router.post('/:userId/reactivate', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.reactivateUser(req.params.userId, req.user!.id);
    res.json(ResponseFormatter.success(user));
  } catch (error) {
    next(error);
  }
});

// DELETE user (FACULTY only, soft delete)
router.delete('/:userId', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await userService.softDeleteUser(req.params.userId);
    res.json(ResponseFormatter.success({ message: 'User deleted' }));
  } catch (error) {
    next(error);
  }
});

export default router;
