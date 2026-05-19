import { Router, Request, Response } from 'express';
import { s3Service } from '../../services/s3.service';
import logger from '../../config/logger';
import { UFMReport } from '../../database/schemas/ufm-report.schema';
import { User } from '../../database/schemas/user.schema';
import { Exam } from '../../database/schemas/exam.schema';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { cleanupUploadedFile, createDiskUpload, openUploadedFileStream } from '../../middleware/disk-upload.middleware';
import { assertExamVisibleToUser, assertSessionVisibleToUser, assertUfmVisibleToUser } from '../../common/utils/ownership';
import { AppException, ForbiddenException } from '../../common/exceptions/app.exceptions';

const router = Router();
const upload = createDiskUpload(100 * 1024 * 1024);

function readObjectKey(req: Request, paramName = 'key') {
  const params = req.params as Record<string, string | undefined>;
  return decodeURIComponent(String(params[0] || params[paramName] || '').replace(/^\/+/, '').trim());
}

function sendRouteError(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof AppException) {
    return res.status(error.statusCode).json({
      status: 'ERROR',
      message: error.message,
      errorCode: error.errorCode,
    });
  }

  return res.status(500).json({
    status: 'ERROR',
    message: fallbackMessage,
  });
}

async function assertS3KeyVisibleToUser(keyOrPrefix: string, req: Request) {
  const key = keyOrPrefix.replace(/^\/+/, '').trim();
  if (!key || key === 'material' || key === 'video' || key === 'report' || key === 'screenshots') {
    throw new ForbiddenException('A scoped S3 key or prefix is required');
  }

  const user = req.user!;
  if (key.startsWith('screenshots/')) {
    const sessionId = key.split('/')[1];
    if (!sessionId) throw new ForbiddenException('Screenshot key must include a session id');
    await assertSessionVisibleToUser(sessionId, user);
    return;
  }

  const [folder, scope, examId] = key.split('/');
  if ((folder === 'material' || folder === 'video' || folder === 'report') && scope === 'exam' && examId) {
    await assertExamVisibleToUser(examId, user);
    return;
  }

  throw new ForbiddenException('Not authorized for this S3 object');
}

/**
 * POST /api/v1/upload/study-material
 * Upload study material to S3
 */
router.post('/study-material/:examId', authMiddleware, rbacMiddleware(['FACULTY']), upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  try {
    const { examId } = req.params;
    await assertExamVisibleToUser(examId, req.user!);

    if (!file) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'No file provided',
      });
    }

    logger.info(`Uploading study material for exam: ${examId}`);

    const fileStream = openUploadedFileStream(file);
    const result = await s3Service.uploadStudyMaterial(
      fileStream,
      examId,
      file.originalname,
      file.mimetype
    );

    res.status(200).json({
      status: 'SUCCESS',
      data: result,
    });
  } catch (error) {
    logger.error('Study material upload failed:', error);
    sendRouteError(res, error, 'Failed to upload study material');
  } finally {
    await cleanupUploadedFile(file);
  }
});

/**
 * POST /api/v1/upload/ufm-evidence/:ufmCaseId
 * Upload UFM evidence video
 */
router.post('/ufm-evidence/:ufmCaseId', authMiddleware, upload.single('video'), async (req: Request, res: Response) => {
  const file = req.file;
  try {
    const { ufmCaseId } = req.params;
    await assertUfmVisibleToUser(ufmCaseId, req.user!);

    if (!file) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'No video file provided',
      });
    }

    if (!file.mimetype.startsWith('video/')) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'File must be a video',
      });
    }

    logger.info(`Uploading UFM evidence for case: ${ufmCaseId}`);

    const report = await UFMReport.findOne({ ufmId: ufmCaseId }).lean();
    const [student, exam] = await Promise.all([
      report?.studentId ? User.findById(report.studentId).select('firstName lastName studentId').lean() : Promise.resolve(null),
      report?.examId ? Exam.findById(report.examId).select('title subject examId courseCode').lean() : Promise.resolve(null),
    ]);
    const studentName = [student?.firstName, student?.lastName].filter(Boolean).join(' ');
    const examName = (exam as any)?.title || (exam as any)?.subject || (exam as any)?.examId || (exam as any)?.courseCode;

    const fileStream = openUploadedFileStream(file);
    const result = await s3Service.uploadUFMEvidence(
      fileStream,
      ufmCaseId,
      file.originalname,
      file.mimetype,
      {
        examId: String(report?.examId || ''),
        examName,
        studentName,
        studentId: (student as any)?.studentId || report?.studentId,
      }
    );

    res.status(200).json({
      status: 'SUCCESS',
      data: result,
    });
  } catch (error) {
    logger.error('UFM evidence upload failed:', error);
    sendRouteError(res, error, 'Failed to upload UFM evidence');
  } finally {
    await cleanupUploadedFile(file);
  }
});

/**
 * POST /api/v1/upload/screenshot/:sessionId
 * Upload screenshot
 */
router.post('/screenshot/:sessionId', authMiddleware, upload.single('image'), async (req: Request, res: Response) => {
  const file = req.file;
  try {
    const { sessionId } = req.params;
    await assertSessionVisibleToUser(sessionId, req.user!);

    if (!file) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'No image file provided',
      });
    }

    logger.info(`Uploading screenshot for session: ${sessionId}`);

    const fileStream = openUploadedFileStream(file);
    const result = await s3Service.uploadScreenshot(fileStream, sessionId, Date.now());

    res.status(200).json({
      status: 'SUCCESS',
      data: result,
    });
  } catch (error) {
    logger.error('Screenshot upload failed:', error);
    sendRouteError(res, error, 'Failed to upload screenshot');
  } finally {
    await cleanupUploadedFile(file);
  }
});

/**
 * GET /api/v1/upload/file/*
 * Get file from S3 (protected - requires auth)
 */
router.get('/file/*', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const key = readObjectKey(req);

    if (!key) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'File key is required',
      });
    }

    await assertS3KeyVisibleToUser(key, req);
    logger.info(`Downloading file: ${key}`);

    const fileStream = await s3Service.getFile(key);

    res.type('application/octet-stream');
    fileStream.pipe(res);
  } catch (error) {
    logger.error('File download failed:', error);
    sendRouteError(res, error, 'Failed to download file');
  }
});

/**
 * GET /api/v1/upload/list/*
 * List files in S3 prefix
 */
router.get('/list/*', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const prefix = readObjectKey(req, 'prefix');

    await assertS3KeyVisibleToUser(prefix, req);
    logger.info(`Listing files with prefix: ${prefix}`);

    const result = await s3Service.listFiles(prefix);

    res.status(200).json({
      status: 'SUCCESS',
      data: result,
    });
  } catch (error) {
    logger.error('File listing failed:', error);
    sendRouteError(res, error, 'Failed to list files');
  }
});

/**
 * DELETE /api/v1/upload/file/*
 * Delete file from S3
 */
router.delete('/file/*', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const key = readObjectKey(req);

    if (!key) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'File key is required',
      });
    }

    await assertS3KeyVisibleToUser(key, req);
    logger.info(`Deleting file: ${key}`);

    const deleted = await s3Service.deleteFile(key);

    res.status(200).json({
      status: 'SUCCESS',
      data: { deleted, key },
    });
  } catch (error) {
    logger.error('File deletion failed:', error);
    sendRouteError(res, error, 'Failed to delete file');
  }
});

/**
 * GET /api/v1/upload/presigned-url/*
 * Get presigned URL for private file
 */
router.get('/presigned-url/*', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const key = readObjectKey(req);
    const expiresIn = parseInt(req.query.expires as string) || 3600;

    if (!key) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'File key is required',
      });
    }

    await assertS3KeyVisibleToUser(key, req);
    logger.info(`Generating presigned URL for: ${key}`);

    const url = s3Service.getPresignedUrl(key, expiresIn);

    res.status(200).json({
      status: 'SUCCESS',
      data: { url, expiresIn },
    });
  } catch (error) {
    logger.error('Presigned URL generation failed:', error);
    sendRouteError(res, error, 'Failed to generate presigned URL');
  }
});

/**
 * GET /api/v1/upload/health
 * Check S3 service health
 */
router.get('/health', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const isHealthy = await s3Service.getHealth();

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      service: 'AWS S3',
      bucket: process.env.AWS_BUCKET_NAME,
      region: process.env.AWS_REGION,
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'AWS S3',
      message: error instanceof Error ? error.message : 'Health check failed',
    });
  }
});

export default router;
