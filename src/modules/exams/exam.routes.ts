import { Router, Request, Response, NextFunction } from 'express';
import { ExamService } from './exam.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { assertExamVisibleToUser } from '../../common/utils/ownership';
import logger from '../../config/logger';

const router = Router();
const examService = new ExamService();

// CREATE exam (FACULTY only)
router.post('/', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exam = await examService.createExam(req.body, req.user!.id, {
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.get('user-agent') || 'unknown',
    });
    res.status(201).json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// GET all exams
router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      status: req.query.status,
      subject: req.query.subject,
      courseCode: req.query.courseCode,
      createdBy: req.user!.role === 'FACULTY' ? req.user!.id : undefined,
      studentId: req.user!.role === 'STUDENT' ? req.user!.id : undefined,
      limit: parseInt(req.query.limit as string) || 50,
      skip: parseInt(req.query.skip as string) || 0,
    };

    // Students see only registered exams
    if (req.user!.role === 'STUDENT') {
      filter.skip = 0;
      filter.limit = 1000; // Get all for filtering
    }

    const result = await examService.getExams(filter);
    res.json(ResponseFormatter.paginated(result.exams, 1, filter.limit, result.total));
  } catch (error) {
    next(error);
  }
});

// GET exam by ID
router.get('/:examId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exam = await examService.getExamById(req.params.examId);
    await assertExamVisibleToUser(req.params.examId, req.user!);
    res.json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// UPDATE exam (FACULTY only)
router.put('/:examId', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exam = await examService.updateExam(req.params.examId, req.body, req.user!.id);
    res.json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// PUBLISH exam (FACULTY only)
router.post('/:examId/publish', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exam = await examService.publishExam(req.params.examId, req.user!.id);
    res.json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// START exam (FACULTY only)
router.post('/:examId/start', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exam = await examService.startExam(req.params.examId, req.user!.id);
    res.json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// END exam (FACULTY only)
router.post('/:examId/end', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = await examService.endExam(req.params.examId, req.user!.id);
    res.json(ResponseFormatter.success(payload));
  } catch (error) {
    next(error);
  }
});

// DELETE exam (FACULTY only)
router.delete('/:examId', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await examService.deleteExam(req.params.examId, req.user!.id);
    res.json(ResponseFormatter.success({ message: 'Exam deleted' }));
  } catch (error) {
    next(error);
  }
});

// REGISTER students for exam (FACULTY only)
router.post('/:examId/register-students', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { studentIds } = req.body;
    const exam = await examService.registerStudents(req.params.examId, studentIds, req.user!.id);
    res.json(ResponseFormatter.success(exam));
  } catch (error) {
    next(error);
  }
});

// GET questions for exam
router.get('/:examId/questions', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const questions = await examService.getQuestions(req.params.examId, req.user!.role === 'FACULTY');
    res.json(ResponseFormatter.success(questions));
  } catch (error) {
    next(error);
  }
});

// ADD question to exam (FACULTY only)
router.post('/:examId/questions', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const question = await examService.addQuestion(req.params.examId, req.body, req.user!.id);
    res.status(201).json(ResponseFormatter.success(question));
  } catch (error) {
    next(error);
  }
});

// UPDATE question (FACULTY only)
router.put('/:examId/questions/:questionId', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const question = await examService.updateQuestion(req.params.questionId, req.body, req.user!.id);
    res.json(ResponseFormatter.success(question));
  } catch (error) {
    next(error);
  }
});

// DELETE question (FACULTY only)
router.delete('/:examId/questions/:questionId', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await examService.deleteQuestion(req.params.questionId, req.user!.id);
    res.json(ResponseFormatter.success({ message: 'Question deleted' }));
  } catch (error) {
    next(error);
  }
});

export default router;
