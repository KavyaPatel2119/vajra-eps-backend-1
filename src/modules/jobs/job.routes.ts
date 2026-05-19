import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { queueService, HeavyJobName } from '../../queues/queue.service';

const router = Router();

router.get('/:jobId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await queueService.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json(ResponseFormatter.error('Job not found', 404));
    }
    res.json(ResponseFormatter.success(job));
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, data } = req.body as { name: HeavyJobName; data?: any };
    const allowed: HeavyJobName[] = [
      'ai-quiz-generation',
      'ocr-pdf-parsing',
      'ufm-pdf-report',
      'video-evidence-processing',
      'bulk-result-finalization',
    ];
    if (!allowed.includes(name)) {
      return res.status(400).json(ResponseFormatter.error('Unsupported job type', 400));
    }
    const jobData = name === 'bulk-result-finalization' ? { ...(data || {}), facultyId: req.user!.id } : (data || {});
    const job = await queueService.addJob(name, jobData);
    res.status(202).json(ResponseFormatter.success(job, 202));
  } catch (error) {
    next(error);
  }
});

export default router;
