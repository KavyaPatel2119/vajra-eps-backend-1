import { Router, Request, Response } from 'express';
import pdfParse from 'pdf-parse';
import { geminiService } from '../../services/gemini.service';
import { queueService } from '../../queues/queue.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { rbacMiddleware } from '../../middleware/rbac.middleware';
import { cleanupUploadedFile, createDiskUpload, openUploadedFileStream, readUploadedFileBuffer } from '../../middleware/disk-upload.middleware';
import { s3Service } from '../../services/s3.service';
import logger from '../../config/logger';
import crypto from 'crypto';

const router = Router();
const upload = createDiskUpload(50 * 1024 * 1024);

function normalizeQuizTypes(raw: unknown): string[] {
  const ALLOW = new Set(['MCQ', 'MSQ', 'SHORT', 'LONG', 'PRACTICAL']);
  const canon = (s: string) => {
    const u = String(s || '').trim().toUpperCase();
    if (u === 'SHORT_ANSWER') return 'SHORT';
    return u;
  };
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw != null && String(raw).trim() !== '') {
    const str = String(raw).trim();
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        list = Array.isArray(parsed) ? parsed : [raw];
      } catch {
        list = [raw];
      }
    } else {
      list = [raw];
    }
  }
  const out = [...new Set(list.map((x) => canon(String(x))))].filter((t) => ALLOW.has(t));
  return out.length > 0 ? out : ['MCQ'];
}

function extractRequestedUnitInstruction(text: string): string | null {
  const match = String(text || '').match(/\bunit\s*[-:]?\s*(\d+)\b/i);
  return match?.[1] || null;
}

function narrowMaterialToRequestedUnit(material: string, instruction: string): string {
  const unitNumber = extractRequestedUnitInstruction(instruction);
  const normalized = String(material || '').trim();
  if (!unitNumber || !normalized) return normalized;

  const escaped = unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(`(^|\\n)\\s*(unit|module|chapter)\\s*[-:]?\\s*${escaped}\\b[\\s\\S]*`, 'i');
  const startMatch = normalized.match(startPattern);
  if (!startMatch || startMatch.index == null) return normalized;

  const fromUnit = normalized.slice(startMatch.index).trim();
  const nextUnitPattern = new RegExp(`\\n\\s*(unit|module|chapter)\\s*[-:]?\\s*(?!${escaped}\\b)\\d+\\b`, 'i');
  const nextMatch = fromUnit.match(nextUnitPattern);
  return (nextMatch?.index ? fromUnit.slice(0, nextMatch.index) : fromUnit).trim() || normalized;
}

function isSupportedMaterialFile(file: Express.Multer.File) {
  const fileName = String(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();
  return (
    mimeType.includes('pdf') ||
    fileName.endsWith('.pdf') ||
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.csv')
  );
}

async function extractMaterialFromFile(file: Express.Multer.File) {
  const buffer = await readUploadedFileBuffer(file);
  const fileName = String(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();

  if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return (parsed.text || '').trim();
  }

  if (
    mimeType.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.csv')
  ) {
    return buffer.toString('utf-8').trim();
  }

  throw new Error('Unsupported file type for AI generation. Use PDF or text files.');
}

async function uploadQueuedAiMaterial(file: Express.Multer.File) {
  const extension = String(file.originalname || '').includes('.')
    ? String(file.originalname).slice(String(file.originalname).lastIndexOf('.')).toLowerCase().replace(/[^a-z0-9.]+/g, '')
    : '';
  const key = `ai/material/${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension || '.txt'}`;
  const uploaded = await s3Service.uploadFile(openUploadedFileStream(file), key, file.mimetype || 'application/octet-stream', {
    'upload-type': 'ai-material',
  });
  return uploaded.key;
}

/**
 * POST /api/v1/ai/generate-quiz
 * Generate quiz from material text
 */
router.post('/generate-quiz', authMiddleware, rbacMiddleware(['FACULTY']), upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  let queuedS3Key: string | undefined;
  let jobQueued = false;
  try {
    const { materialText, difficulty = 'MIXED' } = req.body;
    const questionCount = parseInt(String(req.body.questionCount ?? '5'), 10) || 5;
    const types = normalizeQuizTypes(req.body.types);
    const useQueue = String(req.body.sync || req.query.sync || '').toLowerCase() !== 'true';

    if (file && !isSupportedMaterialFile(file)) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Unsupported file type for AI generation. Use PDF or text files.',
      });
    }

    let extractedMaterial = '';
    if (file && !useQueue) {
      extractedMaterial = await extractMaterialFromFile(file);
    }

    const narrowedMaterial = extractedMaterial
      ? narrowMaterialToRequestedUnit(extractedMaterial, String(materialText || ''))
      : '';

    const finalMaterial = [narrowedMaterial, materialText]
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .join('\n\n---\n\n')
      .trim();

    if ((!finalMaterial || finalMaterial.trim().length === 0) && !file) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Provide study material text or upload a material file',
      });
    }

    if (questionCount < 1 || questionCount > 100) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Question count must be between 1 and 100',
      });
    }

    logger.info(`Generating ${questionCount} quiz questions (types: ${types.join(', ')})...`);

    if (useQueue) {
      queuedS3Key = file ? await uploadQueuedAiMaterial(file) : undefined;
      const job = await queueService.addJob('ai-quiz-generation', {
        materialText: finalMaterial,
        questionCount,
        types,
        difficulty: String(difficulty || 'MIXED').toUpperCase(),
        fileS3Key: queuedS3Key,
        mimeType: file?.mimetype,
        originalName: file?.originalname,
      });
      jobQueued = true;
      return res.status(202).json({
        status: 'ACCEPTED',
        data: job,
      });
    }

    const response = await geminiService.generateQuiz({
      materialText: finalMaterial,
      questionCount,
      types,
      difficulty: String(difficulty || 'MIXED').toUpperCase(),
    });

    const validation = geminiService.validateQuestions(response.questions);

    if (!validation.valid) {
      logger.warn('Validation errors:', validation.errors);
      return res.status(400).json({
        status: 'ERROR',
        message: 'Generated questions failed validation',
        errors: validation.errors,
      });
    }

    res.status(200).json({
      status: 'SUCCESS',
      data: response,
    });
  } catch (error) {
    if (queuedS3Key && !jobQueued) {
      await s3Service.deleteFile(queuedS3Key).catch(() => undefined);
    }
    logger.error('Quiz generation failed:', error);
    res.status(500).json({
      status: 'ERROR',
      message: error instanceof Error ? error.message : 'Failed to generate quiz',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    await cleanupUploadedFile(file);
  }
});

/**
 * POST /api/v1/ai/generate-mcq
 * Generate MCQ questions only
 */
router.post('/generate-mcq', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const { materialText, count = 5 } = req.body;

    if (!materialText) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Material text is required',
      });
    }

    logger.info(`Generating ${count} MCQ questions...`);

    const questions = await geminiService.generateMCQ(materialText, count);

    res.status(200).json({
      status: 'SUCCESS',
      data: {
        questions,
        totalMarks: questions.reduce((sum: number, q: { marks?: number }) => sum + (q.marks || 1), 0),
        type: 'MCQ',
      },
    });
  } catch (error) {
    logger.error('MCQ generation failed:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Failed to generate MCQ questions',
    });
  }
});

/**
 * POST /api/v1/ai/generate-practical
 * Generate practical/coding questions
 */
router.post('/generate-practical', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const { topic, count = 3 } = req.body;

    if (!topic) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Topic is required',
      });
    }

    logger.info(`Generating ${count} practical questions for: ${topic}`);

    const questions = await geminiService.generatePracticalQuestions(topic, count);

    res.status(200).json({
      status: 'SUCCESS',
      data: {
        questions,
        topic,
      },
    });
  } catch (error) {
    logger.error('Practical question generation failed:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Failed to generate practical questions',
    });
  }
});

/**
 * POST /api/v1/ai/extract-topics
 * Extract topics from material
 */
router.post('/extract-topics', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const { materialText } = req.body;

    if (!materialText) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Material text is required',
      });
    }

    logger.info('Extracting topics from material...');

    const topics = await geminiService.extractTopics(materialText);

    res.status(200).json({
      status: 'SUCCESS',
      data: {
        topics,
        count: topics.length,
      },
    });
  } catch (error) {
    logger.error('Topic extraction failed:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Failed to extract topics',
    });
  }
});

/**
 * GET /api/v1/ai/health
 * Check Gemini API health
 */
router.get('/health', authMiddleware, rbacMiddleware(['FACULTY']), async (req: Request, res: Response) => {
  try {
    const isHealthy = await geminiService.getHealth();

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      service: 'Gemini AI',
      timestamp: new Date(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'Gemini AI',
      message: error instanceof Error ? error.message : 'Health check failed',
    });
  }
});

export default router;
