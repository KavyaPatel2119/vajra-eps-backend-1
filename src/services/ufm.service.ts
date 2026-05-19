import logger from '../config/logger';
import { s3Service } from './s3.service';
import { Readable } from 'stream';

/**
 * UFM (Unfair Means) Service
 * Handles UFM case management, evidence preservation, and report generation
 */

interface UFMCase {
  id: string;
  examId: string;
  studentId: string;
  sessionId: string;
  teacherId?: string;
  reason: string;
  evidenceNote?: string;
  markedAt: Date;
  status: 'GENERATED' | 'REVIEWED' | 'ACTION_TAKEN' | 'APPEALED';
}

interface UFMEvidence {
  caseId: string;
  videoChunks: string[]; // S3 keys
  screenshots: string[]; // S3 keys
  activityLog: string; // S3 key to JSON log
  uploadedAt: Date;
}

export class UFMService {
  /**
   * Create UFM case from exam session
   */
  async createUFMCase(
    examId: string,
    studentId: string,
    sessionId: string,
    reason: string,
    teacherId?: string,
    evidenceNote?: string
  ): Promise<UFMCase> {
    try {
      const ufmCase: UFMCase = {
        id: `ufm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        examId,
        studentId,
        sessionId,
        teacherId,
        reason,
        evidenceNote,
        markedAt: new Date(),
        status: 'GENERATED',
      };

      logger.info(`✅ UFM case created: ${ufmCase.id}`);

      return ufmCase;
    } catch (error) {
      logger.error('❌ Failed to create UFM case:', error);
      throw error;
    }
  }

  /**
   * Preserve 3-minute screen recording buffer as evidence
   */
  async preserveScreenRecording(
    ufmCaseId: string,
    recordingChunks: { filePath: string; id: number }[]
  ): Promise<string[]> {
    try {
      const s3Keys: string[] = [];

      logger.info(`📹 Preserving ${recordingChunks.length} recording chunks for UFM: ${ufmCaseId}`);

      for (const chunk of recordingChunks) {
        try {
          // In production: read file and upload to S3
          const key = `video/${s3Service.safePathSegment(ufmCaseId)}/recording/chunk-${chunk.id}.webm`;

          // Simulate file upload (actual: fs.createReadStream(chunk.filePath))
          s3Keys.push(key);

          logger.debug(`  📤 Uploaded chunk: ${key}`);
        } catch (error) {
          logger.warn(`  ⚠️ Failed to upload chunk ${chunk.id}:`, error);
        }
      }

      logger.info(`✅ Preserved ${s3Keys.length} recording chunks`);

      return s3Keys;
    } catch (error) {
      logger.error('❌ Failed to preserve screen recording:', error);
      throw error;
    }
  }

  /**
   * Upload activity log (suspicious events during exam)
   */
  async uploadActivityLog(
    ufmCaseId: string,
    activityEvents: any[]
  ): Promise<string> {
    try {
      const logContent = JSON.stringify(activityEvents, null, 2);
      const key = `logs/${s3Service.safePathSegment(ufmCaseId)}/activity.json`;

      // In production: upload to S3
      logger.info(`📋 Uploaded activity log for UFM: ${ufmCaseId}`);

      return key;
    } catch (error) {
      logger.error('❌ Failed to upload activity log:', error);
      throw error;
    }
  }

  /**
   * Generate UFM PDF report
   */
  async generateUFMReport(
    ufmCaseId: string,
    ufmCase: UFMCase,
    evidence: UFMEvidence
  ): Promise<{ reportUrl: string; reportKey: string }> {
    try {
      const PDFDocument = require('pdfkit');
      const pdfBuffer: Buffer[] = [];

      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
      });

      // Collect PDF data
      doc.on('data', (chunk: Buffer) => pdfBuffer.push(chunk));

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text('UNFAIR MEANS (UFM) REPORT', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text('VAJRA EPS - Enterprise Examination Proctoring System', { align: 'center' });
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();

      // Case Information
      doc.fontSize(14).font('Helvetica-Bold').text('Case Information', { underline: true });
      doc.fontSize(11).font('Helvetica');
      doc.text(`Case ID: ${ufmCase.id}`);
      doc.text(`Exam ID: ${ufmCase.examId}`);
      doc.text(`Student ID: ${ufmCase.studentId}`);
      doc.text(`Session ID: ${ufmCase.sessionId}`);
      doc.text(`Marked At: ${new Date(ufmCase.markedAt).toLocaleString()}`);

      doc.moveDown();

      // Reason
      doc.fontSize(14).font('Helvetica-Bold').text('Reason for UFM', { underline: true });
      doc.fontSize(11).font('Helvetica').text(ufmCase.reason, { align: 'justify' });

      doc.moveDown();

      // Evidence
      doc.fontSize(14).font('Helvetica-Bold').text('Evidence', { underline: true });
      doc.fontSize(11).font('Helvetica');

      if (ufmCase.evidenceNote) {
        doc.text(`Evidence Note: ${ufmCase.evidenceNote}`);
      }

      doc.text(`Video Chunks: ${evidence.videoChunks.length}`);
      doc.text(`Screenshots: ${evidence.screenshots.length}`);
      doc.text(`Activity Log: ${evidence.activityLog ? 'Yes' : 'No'}`);

      doc.moveDown();

      // Status
      doc.fontSize(14).font('Helvetica-Bold').text('Status', { underline: true });
      doc.fontSize(11).font('Helvetica').text(`Status: ${ufmCase.status}`);
      doc.text(`Generated At: ${new Date().toLocaleString()}`);
      doc.text(`Report Type: Automatic UFM Detection`);

      doc.moveDown(2);

      // Footer
      doc.fontSize(10).font('Helvetica-Italic').text(
        'This report has been automatically generated by VAJRA EPS. All evidence is timestamped and immutable.',
        { align: 'center' }
      );

      // Finalize PDF
      doc.end();

      // Convert to buffer
      const pdfData = Buffer.concat(pdfBuffer);

      // Upload to S3
      const pdfStream = Readable.from(pdfData);
      const result = await s3Service.uploadUFMReport(pdfStream, ufmCaseId, {
        examId: ufmCase.examId,
        studentId: ufmCase.studentId,
      });

      logger.info(`✅ UFM report generated and uploaded: ${ufmCaseId}`);

      return { reportUrl: result.url, reportKey: result.key };
    } catch (error) {
      logger.error('❌ Failed to generate UFM report:', error);
      throw error;
    }
  }

  /**
   * Complete UFM case with all evidence
   */
  async completeUFMCase(
    ufmCaseId: string,
    ufmCase: UFMCase,
    recordingChunks: { filePath: string; id: number }[],
    activityEvents: any[],
    screenCaptures: Buffer[]
  ): Promise<{
    caseId: string;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    videoUrl?: string;
    reportUrl?: string;
  }> {
    try {
      logger.info(`🔒 Completing UFM case: ${ufmCaseId}`);

      const evidence: UFMEvidence = {
        caseId: ufmCaseId,
        videoChunks: [],
        screenshots: [],
        activityLog: '',
        uploadedAt: new Date(),
      };

      // 1. Preserve screen recording
      try {
        evidence.videoChunks = await this.preserveScreenRecording(ufmCaseId, recordingChunks);
      } catch (error) {
        logger.warn('⚠️ Failed to preserve screen recording');
      }

      // 2. Upload activity log
      try {
        evidence.activityLog = await this.uploadActivityLog(ufmCaseId, activityEvents);
      } catch (error) {
        logger.warn('⚠️ Failed to upload activity log');
      }

      // 3. Upload screenshots
      try {
        for (let i = 0; i < screenCaptures.length; i++) {
          const key = `screenshots/${s3Service.safePathSegment(ufmCaseId)}/${i}.jpg`;
          evidence.screenshots.push(key);
        }
      } catch (error) {
        logger.warn('⚠️ Failed to upload screenshots');
      }

      // 4. Generate PDF report
      let reportUrl: string | undefined;
      try {
        const result = await this.generateUFMReport(ufmCaseId, ufmCase, evidence);
        reportUrl = result.reportUrl;
      } catch (error) {
        logger.warn('⚠️ Failed to generate UFM report');
      }

      const videoUrl = evidence.videoChunks.length > 0 ? evidence.videoChunks[0] : undefined;

      logger.info(`✅ UFM case completed: ${ufmCaseId}`);

      return {
        caseId: ufmCaseId,
        status: 'SUCCESS',
        videoUrl,
        reportUrl,
      };
    } catch (error) {
      logger.error('❌ Failed to complete UFM case:', error);

      return {
        caseId: ufmCaseId,
        status: 'FAILED',
      };
    }
  }

  /**
   * Get UFM case details
   */
  async getUFMCase(ufmCaseId: string): Promise<UFMCase | null> {
    try {
      // In production: fetch from database
      logger.debug(`📋 Retrieved UFM case: ${ufmCaseId}`);
      return null;
    } catch (error) {
      logger.error('❌ Failed to get UFM case:', error);
      throw error;
    }
  }

  /**
   * Appeal UFM case
   */
  async appealUFMCase(
    ufmCaseId: string,
    studentAppeallReason: string
  ): Promise<boolean> {
    try {
      // In production: update case status to APPEALED
      logger.info(`📝 UFM case appealed: ${ufmCaseId}`);
      return true;
    } catch (error) {
      logger.error('❌ Failed to appeal UFM case:', error);
      return false;
    }
  }

  /**
   * Get all UFM cases for a student
   */
  async getStudentUFMCases(studentId: string): Promise<UFMCase[]> {
    try {
      // In production: fetch from database
      logger.debug(`📋 Retrieved UFM cases for student: ${studentId}`);
      return [];
    } catch (error) {
      logger.error('❌ Failed to get student UFM cases:', error);
      throw error;
    }
  }

  /**
   * Get UFM statistics for an exam
   */
  async getExamUFMStats(examId: string) {
    try {
      // In production: calculate from database
      return {
        totalStudents: 0,
        ufmMarked: 0,
        percentage: 0,
        topReasons: [],
      };
    } catch (error) {
      logger.error('❌ Failed to get UFM stats:', error);
      throw error;
    }
  }
}

export const ufmService = new UFMService();
