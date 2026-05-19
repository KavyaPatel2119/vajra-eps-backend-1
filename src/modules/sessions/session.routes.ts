import { Router, Request, Response, NextFunction } from 'express';
import { SessionService } from './session.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { assertSessionVisibleToUser } from '../../common/utils/ownership';
import logger from '../../config/logger';
import { getRequestIp } from '../../common/utils/request-ip';

const router = Router();
const sessionService = new SessionService();

// START exam session (STUDENT only)
router.post('/:examId/start', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deviceInfo } = req.body;
    const requestDeviceInfo = {
      ...(deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : {}),
      ipAddress: getRequestIp(req),
      userAgent: deviceInfo?.userAgent || req.get('user-agent') || 'unknown',
    };

    const session = await sessionService.startExamSession(req.params.examId, req.user!.id, requestDeviceInfo);
    res.status(201).json(ResponseFormatter.success(session));
  } catch (error) {
    next(error);
  }
});

// GET session status
router.get('/:sessionId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const status = await sessionService.getSessionStatus(req.params.sessionId);
    res.json(ResponseFormatter.success(status));
  } catch (error) {
    next(error);
  }
});

// SAVE answer (STUDENT only)
router.put('/:sessionId/answer', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { questionId, answer, markedForReview } = req.body;

    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const result = await sessionService.saveAnswer(req.params.sessionId, questionId, answer, markedForReview);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// GET session answers
router.get('/:sessionId/answers', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const answers = await sessionService.getSessionAnswers(req.params.sessionId);
    res.json(ResponseFormatter.success(answers));
  } catch (error) {
    next(error);
  }
});

// SUBMIT exam (STUDENT only)
router.post('/:sessionId/submit', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { answers } = req.body;

    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const result = await sessionService.submitExam(req.params.sessionId, answers);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// END session
router.post('/:sessionId/end', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const session = await sessionService.endSession(req.params.sessionId);
    res.json(ResponseFormatter.success(session));
  } catch (error) {
    next(error);
  }
});

// END session by faculty with auto-result calculation and socket emit
router.post('/:sessionId/end-by-faculty', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;
    await assertSessionVisibleToUser(req.params.sessionId, req.user!);
    const result = await sessionService.endSessionByFaculty(req.params.sessionId, req.user!.id, reason || 'Exam ended by faculty');
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

export default router;
