import { Router, Request, Response, NextFunction } from 'express';
import { SurveillanceService } from './surveillance.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { assertExamVisibleToUser, assertSessionVisibleToUser } from '../../common/utils/ownership';
import logger from '../../config/logger';

const router = Router();
const surveillanceService = new SurveillanceService();

// GET session surveillance logs
router.get('/session/:sessionId/logs', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const logs = await surveillanceService.getSessionLogs(req.params.sessionId);
    res.json(ResponseFormatter.success(logs));
  } catch (error) {
    next(error);
  }
});

// GET my surveillance logs (STUDENT only)
router.get('/student/my-logs', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logs = await surveillanceService.getStudentLogs(req.user!.id, req.query.examId as string);
    res.json(ResponseFormatter.success(logs));
  } catch (error) {
    next(error);
  }
});

// GET exam surveillance logs (FACULTY only)
router.get('/exam/:examId/logs', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      eventType: req.query.eventType,
      severity: req.query.severity,
      studentId: req.query.studentId,
      limit: parseInt(req.query.limit as string) || 500,
      skip: parseInt(req.query.skip as string) || 0,
    };

    await assertExamVisibleToUser(req.params.examId, req.user!);
    const result = await surveillanceService.getExamLogs(req.params.examId, filter);
    res.json(ResponseFormatter.paginated(result.logs, 1, filter.limit, result.total));
  } catch (error) {
    next(error);
  }
});

// GET suspicious activities (FACULTY only)
router.get('/exam/:examId/suspicious', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const result = await surveillanceService.getSuspiciousActivities(req.params.examId);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// GET activity statistics (FACULTY only)
router.get('/exam/:examId/stats', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const stats = await surveillanceService.getActivityStats(req.params.examId);
    res.json(ResponseFormatter.success(stats));
  } catch (error) {
    next(error);
  }
});

export default router;
