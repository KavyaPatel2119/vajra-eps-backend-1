import { Server as SocketIOServer, Socket } from 'socket.io';
import logger from '../config/logger';
import { Session } from '../database/schemas/session.schema';
import { SurveillanceLog } from '../database/schemas/surveillance-log.schema';
import { UFMReport } from '../database/schemas/ufm-report.schema';
import { IdGenerator } from '../common/utils/helpers';
import { getSocketIdForSession } from './sessionSocketRegistry';
import { SessionService } from '../modules/sessions/session.service';
import { UFMService as DetailedUFMService } from '../modules/ufm/ufm.service';
import { getSocketUser } from '../middleware/socket-auth.middleware';
import { assertExamVisibleToUser, assertSessionVisibleToUser } from '../common/utils/ownership';

function requireFaculty(socket: Socket): string | null {
  const user = getSocketUser(socket);
  if (!user || user.role !== 'FACULTY') {
    socket.emit('error', { message: 'Faculty socket authorization required' });
    return null;
  }
  return user.id;
}

async function requireFacultyExam(socket: Socket, examId: string): Promise<string | null> {
  const user = getSocketUser(socket);
  if (!user || user.role !== 'FACULTY') {
    socket.emit('error', { message: 'Faculty socket authorization required' });
    return null;
  }
  try {
    await assertExamVisibleToUser(examId, user);
    return user.id;
  } catch {
    socket.emit('error', { message: 'Not authorized for this exam' });
    return null;
  }
}

async function requireFacultySession(socket: Socket, sessionId: string, examId: string) {
  const user = getSocketUser(socket);
  if (!user || user.role !== 'FACULTY') {
    socket.emit('error', { message: 'Faculty socket authorization required' });
    return null;
  }
  try {
    await assertSessionVisibleToUser(sessionId, user);
    const sessionDoc = await Session.findById(sessionId).lean();
    if (!sessionDoc || String(sessionDoc.examId) !== String(examId)) {
      socket.emit('error', { message: 'Session does not belong to this exam' });
      return null;
    }
    return { facultyId: user.id, sessionDoc };
  } catch {
    socket.emit('error', { message: 'Not authorized for this session' });
    return null;
  }
}

async function emitToStudentSession(io: SocketIOServer, sessionMongoId: string, event: string, payload: object) {
  const socketId = await getSocketIdForSession(sessionMongoId);
  if (socketId) {
    io.to(socketId).emit(event, payload);
    return true;
  }
  logger.warn(`No live socket bound for session ${sessionMongoId}; student may be offline`);
  return false;
}

async function appendFacultySurveillanceLog(opts: {
  sessionId: string;
  examId: string;
  studentId: string;
  eventType: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  description: string;
  metadata?: Record<string, unknown>;
}) {
  const sid = opts.studentId?.trim() || 'unknown';
  await SurveillanceLog.create({
    logId: IdGenerator.generateUUID(),
    sessionId: opts.sessionId,
    studentId: sid,
    examId: opts.examId,
    eventType: opts.eventType as any,
    severity: opts.severity,
    description: opts.description,
    metadata: opts.metadata || {},
    eventTime: new Date(),
  });
}

export function setupTeacherCommandHandlers(io: SocketIOServer) {
  io.on('connection', (socket: Socket) => {
    const sessionService = new SessionService();

    socket.on('student:ufm-evidence-uploaded', async (data: { sessionId: string; ufmReportId?: string; url?: string }) => {
      try {
        const user = getSocketUser(socket);
        if (!user || user.role !== 'STUDENT') return;
        const { sessionId, ufmReportId, url } = data;
        if (!ufmReportId || !url) {
          logger.warn('student:ufm-evidence-uploaded missing ufmReportId or url');
          return;
        }

        const sessionDoc = await Session.findById(sessionId).lean();
        if (!sessionDoc || String(sessionDoc.studentId) !== String(user.id)) {
          logger.warn('student:ufm-evidence-uploaded rejected for unauthorized session');
          return;
        }
        const report = await UFMReport.findOne({ ufmId: ufmReportId }).lean();
        if (!report || String(report.studentId) !== String(user.id) || String(report.sessionId) !== String(sessionId)) {
          logger.warn('student:ufm-evidence-uploaded rejected for unauthorized report');
          return;
        }
        await UFMReport.findOneAndUpdate({ ufmId: ufmReportId }, { evidenceVideoUrl: url });

        if (sessionDoc && sessionDoc.examId) {
          io.to(`exam:${sessionDoc.examId}:faculty`).emit('surveillance:ufm-evidence-attached', {
            sessionId,
            ufmReportId,
            url,
            timestamp: new Date(),
          });
        }

        logger.info(`📎 Attached UFM evidence video for report ${ufmReportId}`);
      } catch (err) {
        logger.error('Error handling student:ufm-evidence-uploaded', err);
      }
    });

    socket.on('teacher:freeze-screen', async (data: { sessionId: string; examId: string; reason?: string }) => {
      try {
        const { sessionId, examId, reason } = data;
        const authorized = await requireFacultySession(socket, sessionId, examId);
        if (!authorized) return;

        logger.info(`🔒 Freeze request - Session: ${sessionId}, Reason: ${reason}`);

        await Session.findByIdAndUpdate(sessionId, {
          $set: { isFrozen: true, freezeReason: reason },
        });

        const sessionDoc = authorized.sessionDoc;
        const studentId = sessionDoc?.studentId ? String(sessionDoc.studentId) : '';

        await appendFacultySurveillanceLog({
          sessionId,
          examId,
          studentId,
          eventType: 'SCREEN_FROZEN_BY_FACULTY',
          severity: 'WARNING',
          description: `Screen frozen by faculty. Reason: ${reason || 'None'}`,
        });

        await emitToStudentSession(io, sessionId, 'exam:screen-frozen', {
          reason: reason || 'Your screen has been frozen by faculty',
          timestamp: new Date(),
        });

        io.to(`exam:${examId}:faculty`).emit('surveillance:student-frozen', {
          sessionId,
          reason,
          timestamp: new Date(),
        });

        logger.info(`✅ Screen frozen for session: ${sessionId}`);
      } catch (error) {
        logger.error('❌ Freeze screen error:', error);
        socket.emit('error', { message: 'Failed to freeze screen' });
      }
    });

    socket.on('teacher:unfreeze-screen', async (data: { sessionId: string; examId: string }) => {
      try {
        const { sessionId, examId } = data;
        const authorized = await requireFacultySession(socket, sessionId, examId);
        if (!authorized) return;

        logger.info(`🔓 Unfreeze request - Session: ${sessionId}`);

        await Session.findByIdAndUpdate(sessionId, {
          $set: { isFrozen: false, freezeReason: null },
        });

        const sessionDoc = authorized.sessionDoc;
        const studentId = sessionDoc?.studentId ? String(sessionDoc.studentId) : '';

        await appendFacultySurveillanceLog({
          sessionId,
          examId,
          studentId,
          eventType: 'SCREEN_UNFROZEN_BY_FACULTY',
          severity: 'INFO',
          description: 'Screen unfrozen by faculty',
        });

        await emitToStudentSession(io, sessionId, 'exam:screen-unfrozen', {
          timestamp: new Date(),
        });

        io.to(`exam:${examId}:faculty`).emit('surveillance:student-unfrozen', {
          sessionId,
          timestamp: new Date(),
        });

        logger.info(`✅ Screen unfrozen for session: ${sessionId}`);
      } catch (error) {
        logger.error('❌ Unfreeze screen error:', error);
        socket.emit('error', { message: 'Failed to unfreeze screen' });
      }
    });

    socket.on('teacher:force-submit', async (data: { sessionId: string; examId: string; reason: string }) => {
      try {
        const { sessionId, examId, reason } = data;
        const authorized = await requireFacultySession(socket, sessionId, examId);
        if (!authorized) return;
        const facultyId = authorized.facultyId;

        if (!reason || reason.trim().length === 0) {
          socket.emit('error', { message: 'Reason is required for force submit' });
          return;
        }

        logger.info(`📤 Force submit request - Session: ${sessionId}, Reason: ${reason}`);

        const forceResult = await sessionService.forceSubmitByFaculty(sessionId, facultyId, reason);
        const session = forceResult.session;
        const studentId = String(session.studentId);
        await appendFacultySurveillanceLog({
          sessionId,
          examId,
          studentId,
          eventType: 'FORCE_SUBMITTED_BY_FACULTY',
          severity: 'CRITICAL',
          description: `Exam force-submitted by faculty. Reason: ${reason}`,
        });

        await emitToStudentSession(io, sessionId, 'exam:force-submit-command', {
          reason,
          message: 'Your exam has been force-submitted by faculty',
          timestamp: new Date(),
        });

        io.to(`exam:${examId}:faculty`).emit('surveillance:exam-force-submitted', {
          sessionId,
          reason,
          timestamp: new Date(),
        });

        logger.info(`✅ Exam force-submitted for session: ${sessionId}`);
      } catch (error) {
        logger.error('❌ Force submit error:', error);
        socket.emit('error', { message: 'Failed to force submit exam' });
      }
    });

    socket.on('teacher:end-exam-for-all', async (data: { examId: string; reason?: string; facultyId?: string }) => {
      try {
        const { examId, reason, facultyId } = data;
        const authedFacultyId = await requireFacultyExam(socket, examId);
        if (!authedFacultyId) return;
        logger.info(`🛑 End exam for all requested for exam: ${examId}`);

        // Find all in-progress sessions for this exam
        const sessions = await Session.find({ examId, status: 'IN_PROGRESS' }).lean();

        const results: any[] = [];
        for (const s of sessions) {
          try {
            const res = await sessionService.endSessionByFaculty(String(s._id), authedFacultyId, reason || 'Exam ended by faculty');
            // notify student
            await emitToStudentSession(io, String(s._id), 'exam:ended-by-faculty', { reason: reason || 'Exam ended by faculty' });
            results.push({ sessionId: s._id, status: 'ended' });
          } catch (err) {
            logger.error('Failed to end session during end-exam-for-all', err);
            results.push({ sessionId: s._id, status: 'error' });
          }
        }

        io.to(`exam:${examId}:faculty`).emit('surveillance:exam-ended-for-all', { examId, reason, results });
        logger.info(`✅ End exam for all completed for exam: ${examId}`);
      } catch (error) {
        logger.error('❌ End exam for all error:', error);
        socket.emit('error', { message: 'Failed to end exam for all' });
      }
    });

    socket.on('teacher:send-warning', async (data: { sessionId: string; examId: string; message: string }) => {
      try {
        const { sessionId, examId, message } = data;
        const authorized = await requireFacultySession(socket, sessionId, examId);
        if (!authorized) return;

        logger.info(`⚠️ Warning sent to session: ${sessionId}`);

        const sessionDoc = authorized.sessionDoc;
        const studentId = sessionDoc?.studentId ? String(sessionDoc.studentId) : '';

        await appendFacultySurveillanceLog({
          sessionId,
          examId,
          studentId,
          eventType: 'WARNING_SENT_BY_FACULTY',
          severity: 'WARNING',
          description: `Warning: ${message}`,
        });

        await emitToStudentSession(io, sessionId, 'exam:warning-received', {
          message,
          timestamp: new Date(),
        });

        logger.info(`✅ Warning sent to session: ${sessionId}`);
      } catch (error) {
        logger.error('❌ Send warning error:', error);
        socket.emit('error', { message: 'Failed to send warning' });
      }
    });

    socket.on(
      'teacher:mark-ufm',
      async (data: {
        sessionId: string;
        examId: string;
        studentId: string;
        reason: string;
        evidenceNote?: string;
        ufmReportId?: string;
      }) => {
        try {
          const { sessionId, examId, studentId, reason, evidenceNote, ufmReportId } = data;
          const authorized = await requireFacultySession(socket, sessionId, examId);
          if (!authorized) return;
          const facultyId = authorized.facultyId;
          if (String(authorized.sessionDoc.studentId) !== String(studentId)) {
            socket.emit('error', { message: 'Student does not belong to this session' });
            return;
          }

          if (!reason || reason.trim().length === 0) {
            socket.emit('error', { message: 'Reason is required to mark UFM' });
            return;
          }

          logger.info(`🚫 UFM marked - Student: ${studentId}, Session: ${sessionId}`);

          await Session.findByIdAndUpdate(sessionId, {
            $set: {
              status: 'UFM_MARKED',
              ufmMarkedAt: new Date(),
              ufmReason: reason,
            },
          });

          await appendFacultySurveillanceLog({
            sessionId,
            examId,
            studentId,
            eventType: 'UFM_MARKED_BY_FACULTY',
            severity: 'CRITICAL',
            description: `UFM marked. Reason: ${reason}. Evidence: ${evidenceNote || 'None'}`,
            metadata: { reason, evidenceNote },
          });

          await emitToStudentSession(io, sessionId, 'exam:ufm-marked', {
            reason,
            message: 'You have been marked for unfair means. Your exam cannot continue.',
            timestamp: new Date(),
            ufmReportId: ufmReportId || undefined,
          });

          // Ask the student client to preserve and (optionally) upload the rolling recording buffer.
          // The student app (browser or Electron) should listen for 'recording:preserve-evidence' and
          // trigger its local recorder to save the buffer and upload it to the server or to S3.
          try {
            const preserveSent = await emitToStudentSession(io, sessionId, 'recording:preserve-evidence', {
              ufmReportId: ufmReportId || IdGenerator.generateUUID(),
              note: evidenceNote || 'Preserve recording buffer for UFM case',
              timestamp: new Date(),
            });
            if (!preserveSent) {
              logger.warn(`Could not send preserve-evidence request to session ${sessionId}`);
            }
          } catch (peErr) {
            logger.error('Failed to emit recording:preserve-evidence', peErr);
          }

          io.to(`exam:${examId}:faculty`).emit('surveillance:ufm-marked', {
            studentId,
            sessionId,
            reason,
            timestamp: new Date(),
          });

          // Generate the same detailed UFM PDF used by the faculty and student UFM pages.
          try {
            const ufmService = new DetailedUFMService();
            let reportId = ufmReportId;
            if (!reportId) {
              const createdReport: any = await ufmService.createUFMReport({
                studentId,
                examId,
                sessionId,
                reason: Array.isArray(reason) ? reason : [String(reason)],
                severity: 'CRITICAL',
                evidence:
                  evidenceNote != null && String(evidenceNote).trim().length > 0
                    ? [{ type: 'FACULTY_NOTE', description: String(evidenceNote), data: {}, timestamp: new Date() }]
                    : [],
              });
              reportId = createdReport.ufmId;
            }
            if (!reportId) throw new Error('UFM report id was not generated');
            await ufmService.createAndAttachPdfReport(reportId);

            const evidenceVideoUrl = (data as any).evidenceVideoUrl;
            if (evidenceVideoUrl) await ufmService.attachEvidenceVideoUrl(reportId, evidenceVideoUrl);
          } catch (pdfErr) {
            logger.error('❌ Failed to generate/upload UFM PDF:', pdfErr);
          }

          logger.info(`✅ UFM marked for session: ${sessionId}`);
        } catch (error) {
          logger.error('❌ Mark UFM error:', error);
          socket.emit('error', { message: 'Failed to mark UFM' });
        }
      }
    );
  });
}

export async function isSessionFrozen(sessionId: string): Promise<boolean> {
  try {
    const session = await Session.findById(sessionId);
    return session?.isFrozen ?? false;
  } catch (error) {
    logger.error('❌ Error checking frozen status:', error);
    return false;
  }
}

export async function getFrozenSessions(examId: string) {
  try {
    const sessions = await Session.find({
      examId,
      isFrozen: true,
    });

    return sessions;
  } catch (error) {
    logger.error('❌ Error fetching frozen sessions:', error);
    return [];
  }
}
