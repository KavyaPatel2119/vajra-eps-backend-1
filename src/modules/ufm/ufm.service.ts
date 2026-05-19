import { Readable } from 'stream';
import PDFDocument from 'pdfkit';
import { UFMReport } from '../../database/schemas/ufm-report.schema';
import { User } from '../../database/schemas/user.schema';
import { Exam } from '../../database/schemas/exam.schema';
import { NotFoundException, BadRequestException } from '../../common/exceptions/app.exceptions';
import { IdGenerator } from '../../common/utils/helpers';
import logger from '../../config/logger';
import { S3Service } from '../../services/s3.service';
import * as fs from 'fs';

type UfmStatus = 'OPEN' | 'UNDER_REVIEW' | 'FORWARDED_TO_COMMITTEE' | 'RESOLVED' | 'CLOSED' | 'APPEALED' | 'DISMISSED';

export class UFMService {
  private readonly proofLinkTtlSeconds = 24 * 60 * 60;

  private normalizeEvidence(evidence: any): any[] {
    if (!Array.isArray(evidence)) return [];
    return evidence.map((entry) => {
      if (entry && typeof entry === 'object') {
        return {
          type: String(entry.type || 'EVIDENCE'),
          description: String(entry.description || ''),
          data: entry.data || entry.metadata || {},
          timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
        };
      }
      return String(entry);
    });
  }

  private userName(user: any, fallback: string) {
    return `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || fallback;
  }

  private async enrichReport(report: any) {
    if (!report) return report;
    const plain = typeof report.toObject === 'function' ? report.toObject() : report;
    const s3Service = new S3Service();
    const signedUrl = async (url?: string) => {
      if (!url) return undefined;
      try {
        const exists = await s3Service.fileExistsFromUrl(url);
        if (!exists) {
          logger.warn(`Stored UFM S3 object is missing, hiding stale link: ${url}`);
          return undefined;
        }
        return s3Service.getPresignedUrlFromUrl(url, this.proofLinkTtlSeconds);
      } catch (error) {
        logger.warn(`Unable to create signed S3 URL for UFM asset: ${(error as Error).message}`);
        return undefined;
      }
    };
    const [student, exam, reviewer, evidenceVideoAccessUrl, pdfReportAccessUrl] = await Promise.all([
      User.findById(plain.studentId).select('firstName lastName email studentId class division branch department').lean(),
      Exam.findById(plain.examId).select('title subject courseCode examId createdBy scheduledDate').lean(),
      plain.reviewedBy ? User.findById(plain.reviewedBy).select('firstName lastName email').lean() : Promise.resolve(null),
      signedUrl(plain.evidenceVideoUrl),
      signedUrl(plain.pdfReportUrl),
    ]);
    const faculty = (exam as any)?.createdBy
      ? await User.findById((exam as any).createdBy).select('firstName lastName email').lean()
      : null;

    return {
      ...plain,
      studentName: this.userName(student, 'Unknown student'),
      displayStudentId: (student as any)?.studentId || plain.studentId,
      studentEmail: (student as any)?.email,
      studentClass: [(student as any)?.class, (student as any)?.division].filter(Boolean).join(' - '),
      examName: (exam as any)?.title || (exam as any)?.subject || plain.examId,
      examCode: (exam as any)?.examId || (exam as any)?.courseCode || plain.examId,
      facultyName: this.userName(faculty, 'Faculty'),
      facultyEmail: (faculty as any)?.email,
      reviewerName: this.userName(reviewer, ''),
      evidenceVideoAccessUrl,
      pdfReportAccessUrl,
    };
  }

  async attachEvidenceVideoUrl(ufmId: string, url: string) {
    const report = await UFMReport.findOneAndUpdate({ ufmId }, { $set: { evidenceVideoUrl: url } }, { new: true });
    if (!report) throw new NotFoundException('UFM report not found');
    logger.info(`UFM evidence video URL attached: ${ufmId}`);
    return this.enrichReport(report);
  }

  async getUFMReport(ufmId: string) {
    const report = await UFMReport.findOne({ ufmId });
    if (!report) throw new NotFoundException('UFM report not found');
    return this.enrichReport(report);
  }

  async getStudentUFMReports(studentId: string, filter?: any) {
    const query: any = { studentId };
    if (filter?.examId) query.examId = filter.examId;
    if (filter?.status) query.status = filter.status;
    if (filter?.severity) query.severity = filter.severity;
    const reports = await UFMReport.find(query).limit(filter?.limit || 50).skip(filter?.skip || 0).sort({ createdAt: -1 });
    const total = await UFMReport.countDocuments(query);
    return { reports: await Promise.all(reports.map((r) => this.enrichReport(r))), total };
  }

  async getExamUFMReports(examId: string) {
    const reports = await UFMReport.find({ examId }).sort({ createdAt: -1 });
    const stats = {
      totalReports: reports.length,
      critical: reports.filter((r) => r.severity === 'CRITICAL').length,
      high: reports.filter((r) => r.severity === 'HIGH').length,
      medium: reports.filter((r) => r.severity === 'MEDIUM').length,
      low: reports.filter((r) => r.severity === 'LOW').length,
    };
    return { reports: await Promise.all(reports.map((r) => this.enrichReport(r))), stats };
  }

  async createUFMReport(data: any) {
    const report = await UFMReport.create({
      ufmId: IdGenerator.generateUUID(),
      studentId: data.studentId,
      examId: data.examId,
      sessionId: data.sessionId,
      reason: data.reason || [],
      severity: data.severity || 'MEDIUM',
      evidence: this.normalizeEvidence(data.evidence),
      isImmutable: true,
      status: 'OPEN',
    });
    logger.info(`UFM report created: ${report.ufmId}`);
    return this.enrichReport(report);
  }

  async addEvidenceToReport(ufmId: string, evidence: any) {
    const entry = {
      type: evidence.type,
      description: evidence.description,
      data: evidence.data || evidence.metadata || {},
      timestamp: new Date(),
    };
    const report = await UFMReport.findOneAndUpdate({ ufmId }, { $push: { evidence: entry as any } }, { new: true });
    if (!report) throw new NotFoundException('UFM report not found');
    return this.enrichReport(report);
  }

  async reviewUFMReport(ufmId: string, status: UfmStatus, remarks: string, reviewedBy: string) {
    const validStatuses: UfmStatus[] = ['OPEN', 'UNDER_REVIEW', 'FORWARDED_TO_COMMITTEE', 'RESOLVED', 'CLOSED', 'APPEALED', 'DISMISSED'];
    if (!validStatuses.includes(status)) throw new BadRequestException('Invalid status');
    const report = await UFMReport.findOneAndUpdate(
      { ufmId },
      { $set: { status, remarks, reviewedBy, reviewedAt: new Date() } },
      { new: true }
    );
    if (!report) throw new NotFoundException('UFM report not found');
    return this.enrichReport(report);
  }

  async appealUFMReport(ufmId: string, appealReason: string) {
    const existing = await UFMReport.findOne({ ufmId });
    if (!existing) throw new NotFoundException('UFM report not found');
    if (existing.status !== 'OPEN') throw new BadRequestException('Can only appeal open reports');
    const report = await UFMReport.findOneAndUpdate(
      { ufmId },
      { $set: { status: 'APPEALED', appealReason } },
      { new: true }
    );
    return this.enrichReport(report);
  }

  async getAllUFMReports(filter?: any) {
    const query: any = {};
    if (filter?.severity) query.severity = filter.severity;
    if (filter?.status) query.status = filter.status;
    if (filter?.examIds) query.examId = { $in: filter.examIds };
    const reports = await UFMReport.find(query).limit(filter?.limit || 100).skip(filter?.skip || 0).sort({ createdAt: -1 });
    const total = await UFMReport.countDocuments(query);
    return { reports: await Promise.all(reports.map((r) => this.enrichReport(r))), total };
  }

  private async generateReportPdfBuffer(ufmId: string): Promise<Buffer> {
    const report: any = await this.getUFMReport(ufmId);
    const doc = new PDFDocument({ margin: 56, size: 'A4', bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    const reasons = Array.isArray(report.reason) ? report.reason.join(', ') : String(report.reason || 'UFM case reported');
    const evidence = Array.isArray(report.evidence) ? report.evidence : [];
    const statusLabel = String(report.status || '').replace(/_/g, ' ');
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const section = (title: string) => {
      doc.moveDown(1.25);
      doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(13).text(title, { width: pageWidth });
      doc.moveDown(0.28);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#d7dce2').lineWidth(0.8).stroke();
      doc.moveDown(0.65);
      doc.fillColor('#111827').font('Helvetica').fontSize(10.5);
    };
    const row = (label: string, value: unknown) => {
      doc.font('Helvetica-Bold').fillColor('#374151').text(`${label}: `, { continued: true, width: pageWidth });
      doc.font('Helvetica').fillColor('#111827').text(String(value || '-'), { width: pageWidth });
      doc.moveDown(0.28);
    };

    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text('VAJRA EPS', { align: 'center', width: pageWidth });
    doc.moveDown(0.35);
    doc.fontSize(15).text('Unfair Means Case Report', { align: 'center', width: pageWidth });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9.5).fillColor('#475569').text(
      `Generated ${new Date().toLocaleString()} | Confidential academic review document`,
      { align: 'center', width: pageWidth }
    );
    doc.moveDown(1.4);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Prepared By: ', { continued: true });
    doc.font('Helvetica').text(report.facultyName || 'Faculty Invigilator');
    doc.font('Helvetica-Bold').text('Institution/System: ', { continued: true });
    doc.font('Helvetica').text('VAJRA EPS Examination Protection');
    doc.font('Helvetica-Bold').text('Case Reference: ', { continued: true });
    doc.font('Helvetica').text(report.ufmId);
    doc.moveDown(0.6);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#e5e7eb').stroke();

    section('Case Name and Citation');
    row('Case Name', `${report.studentName} - ${report.examName}`);
    row('Case ID', report.ufmId);
    row('Exam Citation', `${report.examCode || report.examId} / Session record retained by VAJRA EPS`);

    section('Facts of the Case');
    doc.text(
      `On ${report.createdAt ? new Date(report.createdAt).toLocaleString() : 'the recorded examination date'}, a UFM case was reported for ${report.studentName} during ${report.examName}. The case was initiated by ${report.facultyName || 'the invigilator'} with severity ${report.severity}. The allegation recorded by faculty was: ${reasons}.`,
      { width: pageWidth, align: 'justify' }
    );

    section('Case Overview');
    row('Current Status', statusLabel);
    row('Severity', report.severity);
    row('Reported At', report.createdAt ? new Date(report.createdAt).toLocaleString() : '-');
    row('Last Updated', report.updatedAt ? new Date(report.updatedAt).toLocaleString() : '-');

    section('Student Details');
    row('Student Name', report.studentName);
    row('Student ID', report.displayStudentId || report.studentId);
    row('Email', report.studentEmail || '-');
    row('Class / Division', report.studentClass || '-');

    section('Examination Details');
    row('Exam Name', report.examName);
    row('Exam Code', report.examCode || report.examId);
    row('Faculty / Invigilator', report.facultyName || 'Faculty');

    section('Issues for Committee Review');
    doc.text(`1. Primary Issue: Whether the recorded activity constitutes unfair means under examination rules.`);
    doc.text(`2. Secondary Issue: Whether technical circumstances or student explanation alter the case decision.`);
    doc.text(`3. Evidence Issue: Whether screen recording, logs, and faculty notes sufficiently support the allegation.`);

    section('Allegation and Faculty Notes');
    doc.text(reasons, { width: 500, align: 'left' });

    section('Evidence Summary');
    if (evidence.length === 0) {
      doc.text('No additional evidence notes recorded.');
    } else {
      evidence.forEach((item: any, index: number) => {
        const text = typeof item === 'string' ? item : item?.description || item?.type || JSON.stringify(item);
        doc.text(`${index + 1}. ${text}`);
      });
    }
    row('Screen Proof URL', report.evidenceVideoUrl || 'Not uploaded yet');
    row('PDF Report URL', report.pdfReportUrl || 'Generated during this request');

    section('Student Statement / Appeal');
    if (report.appealReason) {
      doc.text(report.appealReason, { width: 500, align: 'left' });
    } else {
      doc.fillColor('#64748b').text('No student statement has been submitted yet.');
    }

    section('Digital Signature and Acknowledgement');
    row('Digital Signature', `${report.studentName} / ${report.displayStudentId || report.studentId}`);
    doc.fillColor('#475569').text(
      'The student is informed before examination entry that, if a UFM case is detected, the student name and student ID may be used as a digital acknowledgement/signature in the official case record.',
      { width: pageWidth, align: 'justify' }
    );

    section('Review Notes');
    row('Reviewed By', report.reviewerName || report.reviewedBy || '-');
    row('Reviewed At', report.reviewedAt ? new Date(report.reviewedAt).toLocaleString() : '-');
    doc.text(report.remarks || 'No committee/faculty remarks recorded.');

    doc.moveDown(1.5).fontSize(9).fillColor('#475569').text(
      'Confidentiality notice: This report is generated by VAJRA EPS for authorized academic review only. Evidence should be evaluated according to institutional policy before final disciplinary action.',
      { align: 'left' }
    );
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#6b7280').text(`VAJRA EPS UFM Report | Page ${i + 1} of ${pages.count}`, 56, 780, {
        width: pageWidth,
        align: 'center',
        lineBreak: false,
      });
    }
    doc.end();
    return done;
  }

  async createAndAttachPdfReport(ufmId: string) {
    const pdfBuffer = await this.generateReportPdfBuffer(ufmId);
    const s3Service = new S3Service();
    const reportInfo: any = await this.getUFMReport(ufmId);
    const uploaded = await s3Service.uploadUFMReport(Readable.from(pdfBuffer), ufmId, {
      examId: reportInfo.examId,
      examName: reportInfo.examName || reportInfo.examCode || reportInfo.examId,
      studentName: reportInfo.studentName,
      studentId: reportInfo.displayStudentId || reportInfo.studentId,
    });
    const report = await UFMReport.findOneAndUpdate({ ufmId }, { $set: { pdfReportUrl: uploaded.url } }, { new: true });
    if (!report) throw new NotFoundException('UFM report not found');
    return this.enrichReport(report);
  }

  async forwardToCommittee(ufmId: string, note?: string) {
    const report = await UFMReport.findOne({ ufmId });
    if (!report) throw new NotFoundException('UFM report not found');
    return this.reviewUFMReport(ufmId, 'FORWARDED_TO_COMMITTEE', note || 'Forwarded to UFM committee', report.reviewedBy || '');
  }

  async uploadEvidenceToS3(ufmId: string, evidenceFilePath: string): Promise<{ url: string; key: string }> {
    const existing = await UFMReport.findOne({ ufmId });
    if (!existing) throw new NotFoundException('UFM report not found');
    if (!fs.existsSync(evidenceFilePath)) throw new BadRequestException(`Evidence file not found: ${evidenceFilePath}`);
    const s3Service = new S3Service();
    const info = await this.enrichReport(existing as any);
    const origName = (existing as any).originalFileName || `evidence-${Date.now()}.mp4`;
    const s3Result = await s3Service.uploadUFMEvidence(fs.createReadStream(evidenceFilePath), ufmId, origName, 'video/mp4', {
      examId: info.examId,
      examName: info.examName || info.examCode || info.examId || ufmId,
      studentName: info.studentName,
      studentId: info.displayStudentId || info.studentId,
    });
    await UFMReport.findOneAndUpdate(
      { ufmId },
      {
        $set: { evidenceVideoUrl: s3Result.url },
        $push: {
          evidence: {
            type: 'VIDEO_EVIDENCE',
            description: `Screen recording evidence uploaded to S3: ${s3Result.url}`,
            data: { fileName: origName, s3Key: s3Result.key, s3Url: s3Result.url, uploadedAt: new Date() },
            timestamp: new Date(),
          } as any,
        },
      },
      { new: true }
    );
    return { url: s3Result.url, key: s3Result.key };
  }
}
