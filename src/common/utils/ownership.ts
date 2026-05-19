import { Exam } from '../../database/schemas/exam.schema';
import { Session } from '../../database/schemas/session.schema';
import { Result } from '../../database/schemas/result.schema';
import { UFMReport } from '../../database/schemas/ufm-report.schema';
import { AuthUser } from '../types';
import { ForbiddenException, NotFoundException } from '../exceptions/app.exceptions';
import { toIdString } from './id-normalize';

export async function assertExamVisibleToUser(examId: string, user: AuthUser) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new NotFoundException('Exam');

  if (user.role === 'FACULTY') {
    if (toIdString(exam.createdBy) !== String(user.id)) {
      throw new ForbiddenException('Not authorized for this exam');
    }
    return exam;
  }

  const studentId = String(user.id);
  const registered = Array.isArray(exam.registeredStudents)
    ? exam.registeredStudents.map((id) => String(id)).includes(studentId)
    : false;
  if (!registered) {
    const hasSession = await Session.exists({ examId, studentId });
    if (!hasSession) throw new ForbiddenException('Not authorized for this exam');
  }
  return exam;
}

export async function assertSessionVisibleToUser(sessionId: string, user: AuthUser) {
  const session = await Session.findById(sessionId);
  if (!session) throw new NotFoundException('Session');

  if (user.role === 'STUDENT') {
    if (String(session.studentId) !== String(user.id)) {
      throw new ForbiddenException('Not authorized for this session');
    }
    return session;
  }

  await assertExamVisibleToUser(String(session.examId), user);
  return session;
}

export async function assertResultVisibleToUser(resultId: string, user: AuthUser) {
  const result = await Result.findOne({ resultId });
  if (!result) throw new NotFoundException('Result');

  if (user.role === 'STUDENT') {
    if (String(result.studentId) !== String(user.id)) {
      throw new ForbiddenException('Not authorized for this result');
    }
    return result;
  }

  await assertExamVisibleToUser(String(result.examId), user);
  return result;
}

export async function assertUfmVisibleToUser(ufmId: string, user: AuthUser) {
  const report = await UFMReport.findOne({ ufmId });
  if (!report) throw new NotFoundException('UFM report');

  if (user.role === 'STUDENT') {
    if (String(report.studentId) !== String(user.id)) {
      throw new ForbiddenException('Not authorized for this UFM report');
    }
    return report;
  }

  await assertExamVisibleToUser(String(report.examId), user);
  return report;
}
