import { Job, Queue, Worker } from 'bullmq';
import logger from '../config/logger';
import { geminiService } from '../services/gemini.service';
import { UFMService } from '../modules/ufm/ufm.service';
import { ExamService } from '../modules/exams/exam.service';
import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { s3Service } from '../services/s3.service';

export type HeavyJobName =
  | 'ai-quiz-generation'
  | 'ocr-pdf-parsing'
  | 'ufm-pdf-report'
  | 'video-evidence-processing'
  | 'bulk-result-finalization';

const redisUrl = process.env.REDIS_URL || process.env.BULLMQ_REDIS_URL || 'redis://127.0.0.1:6379';
const parsedRedis = new URL(redisUrl);
const connection = {
  host: parsedRedis.hostname,
  port: Number(parsedRedis.port || 6379),
  username: parsedRedis.username || undefined,
  password: parsedRedis.password || undefined,
};
const queuesDisabled = process.env.NODE_ENV === 'test' || process.env.BULLMQ_DISABLED === 'true';

async function readJobFileBuffer(data: any) {
  if (data.fileS3Key) {
    return streamToBuffer(await s3Service.getFile(String(data.fileS3Key)));
  }
  if (data.filePath) {
    return fs.readFile(String(data.filePath));
  }
  if (data.fileBase64) {
    return Buffer.from(String(data.fileBase64), 'base64');
  }
  return null;
}

async function cleanupJobFile(data: any) {
  if (data.fileS3Key) {
    await s3Service.deleteFile(String(data.fileS3Key));
  }
  if (!data.filePath) return;
  await fs.unlink(String(data.filePath)).catch((error) => {
    logger.warn(`Failed to remove queued upload file: ${data.filePath}`, error);
  });
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isFinalAttempt(job: Job) {
  const attempts = Number(job.opts.attempts || 1);
  return job.attemptsMade + 1 >= attempts;
}

class QueueService {
  private queue?: Queue;
  private worker?: Worker;

  private getQueue() {
    if (queuesDisabled) {
      throw new Error('Background queue is disabled in this environment');
    }
    if (!this.queue) {
      this.queue = new Queue('vajra-heavy-tasks', { connection });
    }
    return this.queue;
  }

  async addJob(name: HeavyJobName, data: any) {
    const job = await this.getQueue().add(name, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });

    return {
      jobId: String(job.id),
      name,
      status: 'queued',
      statusUrl: `/api/v1/jobs/${job.id}`,
    };
  }

  async getJob(jobId: string) {
    const job = await Job.fromId(this.getQueue(), jobId);
    if (!job) return null;
    const [state, progress] = await Promise.all([job.getState(), Promise.resolve(job.progress)]);
    return {
      id: String(job.id),
      name: job.name,
      state,
      progress,
      result: state === 'completed' ? job.returnvalue : undefined,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      createdAt: job.timestamp ? new Date(job.timestamp) : undefined,
      processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
    };
  }

  startWorker() {
    if (queuesDisabled) {
      logger.info('Background queue worker disabled in this environment');
      return;
    }
    if (this.worker) return;
    this.worker = new Worker(
      'vajra-heavy-tasks',
      async (job) => {
        logger.info(`Processing heavy job ${job.name}:${job.id}`);
        if (job.name === 'ai-quiz-generation') {
          try {
            await job.updateProgress(10);
            let materialText = String(job.data.materialText || '');
            const buffer = await readJobFileBuffer(job.data);
            if (buffer) {
              const fileName = String(job.data.originalName || '').toLowerCase();
              const mimeType = String(job.data.mimeType || '').toLowerCase();
              const isPdf = mimeType.includes('pdf') || fileName.endsWith('.pdf');
              const isText =
                mimeType.startsWith('text/') ||
                fileName.endsWith('.txt') ||
                fileName.endsWith('.md') ||
                fileName.endsWith('.csv');

              if (!isPdf && !isText) {
                throw new Error('Unsupported file type for AI generation. Use PDF or text files.');
              }

              if (isPdf) {
                const parsed = await pdfParse(buffer);
                materialText = [parsed.text, materialText].filter(Boolean).join('\n\n---\n\n');
              } else {
                materialText = [buffer.toString('utf-8'), materialText].filter(Boolean).join('\n\n---\n\n');
              }
            }
            const result = await geminiService.generateQuiz({
              ...job.data,
              materialText,
              filePath: undefined,
              fileS3Key: undefined,
              fileBase64: undefined,
            });
            await job.updateProgress(100);
            await cleanupJobFile(job.data);
            return result;
          } catch (error) {
            if (isFinalAttempt(job)) {
              await cleanupJobFile(job.data);
            }
            throw error;
          }
        }
        if (job.name === 'ocr-pdf-parsing') {
          try {
            await job.updateProgress(20);
            const buffer = await readJobFileBuffer(job.data);
            if (!buffer) throw new Error('No file provided for OCR parsing');
            const parsed = await pdfParse(buffer);
            await job.updateProgress(100);
            await cleanupJobFile(job.data);
            return { text: parsed.text || '', pages: parsed.numpages || 0 };
          } catch (error) {
            if (isFinalAttempt(job)) {
              await cleanupJobFile(job.data);
            }
            throw error;
          }
        }
        if (job.name === 'ufm-pdf-report') {
          const ufmService = new UFMService();
          const report = await ufmService.createAndAttachPdfReport(job.data.ufmId);
          await job.updateProgress(100);
          return report;
        }
        if (job.name === 'video-evidence-processing') {
          await job.updateProgress(100);
          return { processed: true, message: 'Video evidence queued for external media processing' };
        }
        if (job.name === 'bulk-result-finalization') {
          if (job.data.examId && job.data.facultyId) {
            const examService = new ExamService();
            const result = await examService.endExam(String(job.data.examId), String(job.data.facultyId));
            await job.updateProgress(100);
            return result;
          }
          await job.updateProgress(100);
          return { finalized: true, message: 'Bulk finalization job accepted' };
        }
        throw new Error(`Unsupported job type: ${job.name}`);
      },
      { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) }
    );

    this.worker.on('failed', (job, error) => {
      logger.error(`Heavy job failed ${job?.name}:${job?.id}`, error);
    });
  }
}

export const queueService = new QueueService();
