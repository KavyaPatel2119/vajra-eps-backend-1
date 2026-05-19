import { Router, Request, Response, NextFunction } from 'express';
import { UFMService } from './ufm.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { ResponseFormatter } from '../../common/utils/response.formatter';
import { BadRequestException, ForbiddenException } from '../../common/exceptions/app.exceptions';
import { s3Service } from '../../services/s3.service';
import { Exam } from '../../database/schemas/exam.schema';
import { assertExamVisibleToUser, assertUfmVisibleToUser } from '../../common/utils/ownership';
import { queueService } from '../../queues/queue.service';
import { cleanupUploadedFile, createDiskUpload, openUploadedFileStream } from '../../middleware/disk-upload.middleware';
import logger from '../../config/logger';

const router = Router();
const ufmService = new UFMService();
const upload = createDiskUpload(500 * 1024 * 1024); // 500MB for video

async function queueOrGenerateUfmPdf(ufmId: string) {
  try {
    return {
      mode: 'queued',
      job: await queueService.addJob('ufm-pdf-report', { ufmId }),
    };
  } catch (queueError) {
    logger.warn('UFM PDF queue unavailable; generating report synchronously', queueError);
    try {
      return {
        mode: 'sync',
        report: await ufmService.createAndAttachPdfReport(ufmId),
      };
    } catch (syncError) {
      logger.error('UFM PDF generation failed after queue fallback', syncError);
      return {
        mode: 'failed',
        error: syncError instanceof Error ? syncError.message : 'UFM PDF generation failed',
      };
    }
  }
}

// POST create UFM case (FACULTY) — must be registered before /:ufmId routes
router.post('/cases', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { examId, studentId, sessionId, reason, evidenceNote } = req.body || {};
    if (!examId || !studentId || !sessionId || !reason) {
      throw new BadRequestException('examId, studentId, sessionId, and reason are required');
    }
    const reasonArr = Array.isArray(reason) ? reason : [String(reason)];
    await assertExamVisibleToUser(String(examId), req.user!);
    const evidence =
      evidenceNote != null && String(evidenceNote).trim().length > 0
        ? [
            {
              type: 'FACULTY_NOTE',
              description: String(evidenceNote),
              data: {},
              timestamp: new Date(),
            },
          ]
        : [];

    const report = await ufmService.createUFMReport({
      studentId: String(studentId),
      examId: String(examId),
      sessionId: String(sessionId),
      reason: reasonArr,
      severity: 'CRITICAL',
      evidence,
    });
    const pdf = await queueOrGenerateUfmPdf(String((report as any).ufmId));

    res.status(201).json(ResponseFormatter.success({ report, pdf }));
  } catch (error) {
    next(error);
  }
});

// GET my UFM reports (STUDENT only)
router.get('/student/my-reports', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      examId: req.query.examId,
      status: req.query.status,
      severity: req.query.severity,
      limit: parseInt(req.query.limit as string) || 50,
      skip: parseInt(req.query.skip as string) || 0,
    };

    const result = await ufmService.getStudentUFMReports(req.user!.id, filter);
    res.json(ResponseFormatter.paginated(result.reports, 1, filter.limit, result.total));
  } catch (error) {
    next(error);
  }
});

// GET exam UFM reports (FACULTY only)
router.get('/exam/:examId/reports', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertExamVisibleToUser(req.params.examId, req.user!);
    const result = await ufmService.getExamUFMReports(req.params.examId);
    res.json(ResponseFormatter.success(result));
  } catch (error) {
    next(error);
  }
});

// GET all UFM reports (FACULTY only)
router.get('/', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = {
      severity: req.query.severity,
      status: req.query.status,
      examIds: (await Exam.find({ createdBy: req.user!.id }).select('_id').lean()).map((exam) => String(exam._id)),
      limit: parseInt(req.query.limit as string) || 100,
      skip: parseInt(req.query.skip as string) || 0,
    };

    const result = await ufmService.getAllUFMReports(filter);
    res.json(ResponseFormatter.paginated(result.reports, 1, filter.limit, result.total));
  } catch (error) {
    next(error);
  }
});

// ADD evidence to UFM report (FACULTY only)
router.post('/:ufmId/evidence', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, description, metadata } = req.body;

    if (!type || !description) {
      throw new BadRequestException('Type and description required');
    }

    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.addEvidenceToReport(req.params.ufmId, {
      type,
      description,
      metadata: metadata || {},
    });

    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// REVIEW UFM report (FACULTY only)
router.post('/:ufmId/review', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, remarks } = req.body;

    if (!status || !remarks) {
      throw new BadRequestException('Status and remarks required');
    }

    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.reviewUFMReport(req.params.ufmId, status, remarks, req.user!.id);
    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// Generate/upload formatted PDF report and attach it to the case
router.post('/:ufmId/generate-pdf', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    if (String(req.query.sync || '').toLowerCase() === 'true') {
      const report = await ufmService.createAndAttachPdfReport(req.params.ufmId);
      return res.json(ResponseFormatter.success(report));
    }
    const pdf = await queueOrGenerateUfmPdf(req.params.ufmId);
    res.status(pdf.mode === 'queued' ? 202 : 200).json(ResponseFormatter.success(pdf, pdf.mode === 'queued' ? 202 : 200));
  } catch (error) {
    next(error);
  }
});

// Forward case to UFM committee review queue by updating status only
router.post('/:ufmId/forward-committee', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.forwardToCommittee(req.params.ufmId, req.body?.note);
    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// APPEAL UFM report (STUDENT only)
router.post('/:ufmId/appeal', authMiddleware, rbacMiddleware(['STUDENT']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { appealReason } = req.body;

    if (!appealReason) {
      throw new BadRequestException('Appeal reason required');
    }

    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.appealUFMReport(req.params.ufmId, appealReason);
    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// Attach S3 (or CDN) URL for screen evidence — students upload first via /upload/ufm-evidence/:ufmId
router.post('/:ufmId/attach-evidence-video', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) {
      throw new BadRequestException('url is required');
    }
    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.attachEvidenceVideoUrl(req.params.ufmId, url);
    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// GET UFM report by ufmId (must be last — dynamic segment)
router.get('/:ufmId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const report = await ufmService.getUFMReport(req.params.ufmId);
    res.json(ResponseFormatter.success(report));
  } catch (error) {
    next(error);
  }
});

// Upload UFM evidence video file from Electron recording buffer and attach S3 URL.
// Students may upload only their own UFM proof; faculty may upload/retry for any case.
router.post('/:ufmId/upload-evidence-video', authMiddleware, upload.single('evidenceVideo'), async (req: Request, res: Response, next: NextFunction) => {
  const file = req.file;
  try {
    if (!file) {
      throw new BadRequestException('evidenceVideo file is required');
    }

    await assertUfmVisibleToUser(req.params.ufmId, req.user!);
    const reportBeforeUpload = await ufmService.getUFMReport(req.params.ufmId);

    // Validate video file
    if (!file.mimetype.startsWith('video/') && file.mimetype !== 'application/octet-stream') {
      throw new BadRequestException('File must be a video');
    }

    logger.info(`📹 Uploading UFM evidence video for case: ${req.params.ufmId}`);

    const fileStream = openUploadedFileStream(file);
    const s3Result = await s3Service.uploadUFMEvidence(
      fileStream,
      req.params.ufmId,
      file.originalname || `ufm-evidence-${req.params.ufmId}.mp4`,
      file.mimetype === 'application/octet-stream' ? 'video/mp4' : file.mimetype,
      {
        examId: String((reportBeforeUpload as any).examId || ''),
        examName: (reportBeforeUpload as any).examName || (reportBeforeUpload as any).examCode || (reportBeforeUpload as any).examId,
        studentName: (reportBeforeUpload as any).studentName,
        studentId: (reportBeforeUpload as any).displayStudentId || (reportBeforeUpload as any).studentId,
      }
    );

    // Attach the S3 URL to the UFM report
    const report = await ufmService.attachEvidenceVideoUrl(req.params.ufmId, s3Result.url);

    logger.info(`✅ Evidence video uploaded to S3 and attached: ${s3Result.url}`);

    res.json(ResponseFormatter.success({ 
      ufmId: req.params.ufmId, 
      s3Url: s3Result.url,
      report 
    }));
  } catch (error) {
    next(error);
  } finally {
    await cleanupUploadedFile(file);
  }
});

export default router;
