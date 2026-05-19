import { Router, Request, Response, NextFunction } from 'express';
import { ResultService } from './result.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { assertExamVisibleToUser, assertResultVisibleToUser } from '../../common/utils/ownership';
import logger from '../../config/logger';

const router = Router();
const resultService = new ResultService();

// GET my results (STUDENT)
router.get('/student/my-results', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      examId: req.query.examId,
      status: req.query.status,
      limit: parseInt(req.query.limit as string) || 50,
      skip: parseInt(req.query.skip as string) || 0,
    };

    const results = await resultService.getStudentResultsEnriched(req.user!.id, filter);
    res.json(ResponseFormatter.paginated(results.results, 1, filter.limit, results.total));
  } catch (error) {
    next(error);
  }
});

// FIX #4: GET student marks for an exam (FACULTY only) - for Faculty Marks View
router.get('/exam/:examId/student-marks', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = parseInt(req.query.skip as string) || 0;
    const studentName = req.query.studentName as string;
    const sortBy = (req.query.sortBy as string) || 'obtainedMarks'; // 'obtainedMarks', 'percentage', 'grade', 'studentId'
    const sortOrder = (req.query.sortOrder as string) === 'asc' ? 1 : -1;

    await assertExamVisibleToUser(req.params.examId, req.user!);
    const results = await resultService.getStudentMarksForExam(
      req.params.examId,
      { limit, skip, studentName, sortBy, sortOrder }
    );
    res.json(ResponseFormatter.paginated(results.marks, Math.floor(skip / limit) + 1, limit, results.total));
  } catch (error) {
    next(error);
  }
});

// GET exam results (FACULTY only)
router.get('/exam/:examId/results', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const results = await resultService.getExamResults(req.params.examId);
    res.json(ResponseFormatter.success(results));
  } catch (error) {
    next(error);
  }
});

// PUBLISH results (FACULTY only)
router.post('/exam/:examId/publish', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const result = await resultService.publishResults(req.params.examId);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// GET result details
router.get('/:resultId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertResultVisibleToUser(req.params.resultId, req.user!);
    const result = await resultService.getDetailedResult(req.params.resultId);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// GET topic analysis
router.get('/:resultId/analysis', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertResultVisibleToUser(req.params.resultId, req.user!);
    const analysis = await resultService.getTopicsAnalysis(req.params.resultId);
    res.json(ResponseFormatter.success(analysis));
  } catch (error) {
    next(error);
  }
});

export default router;
