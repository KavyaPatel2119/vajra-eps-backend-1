import { Router, Request, Response, NextFunction } from 'express';
import { collegeService } from './college.service';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

// GET /api/v1/colleges
router.get('/', authMiddleware, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const colleges = await collegeService.getAllColleges();
    res.status(200).json(ResponseFormatter.success(colleges));
  } catch (error) {
    next(error);
  }
});

export default router;
