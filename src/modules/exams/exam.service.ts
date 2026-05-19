import { Exam } from '../../database/schemas/exam.schema';
import { Session } from '../../database/schemas/session.schema';
import { Question } from '../../database/schemas/question.schema';
import { AuditLog } from '../../database/schemas/audit-log.schema';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '../../common/exceptions/app.exceptions';
import { IdGenerator, ValidationUtils } from '../../common/utils/helpers';
import logger from '../../config/logger';
import { getSocketHub } from '../../realtime/socket-hub';
import { toIdString, normalizeStudentIdList } from '../../common/utils/id-normalize';
import { SessionService } from '../sessions/session.service';

export class ExamService {
  private sessionService = new SessionService();

  async createExam(
    examData: any,
    facultyId: string,
    requestMeta?: { ipAddress?: string; userAgent?: string }
  ) {
    try {
      // Validate exam duration
      if (!ValidationUtils.validateExamDuration(examData.duration)) {
        throw new BadRequestException('Exam duration must be between 15 and 480 minutes');
      }

      // Validate marks
      if (!ValidationUtils.validateMarks(examData.passingMarks, examData.totalMarks)) {
        throw new BadRequestException('Passing marks cannot exceed total marks');
      }

      const exam = await Exam.create({
        examId: IdGenerator.generateExamId(),
        title: examData.title,
        description: examData.description,
        subject: examData.subject,
        courseCode: examData.courseCode,
        createdBy: facultyId,
        duration: examData.duration,
        totalMarks: examData.totalMarks,
        passingMarks: examData.passingMarks,
        scheduledDate: examData.scheduledDate,
        status: 'DRAFT',
        registeredStudents: [],
        questionCount: 0,
      });

      // Log audit event
      await AuditLog.create({
        auditId: IdGenerator.generateUUID(),
        userId: facultyId,
        action: 'CREATE_EXAM',
        resourceType: 'Exam',
        resourceId: String(exam._id),
        ipAddress: requestMeta?.ipAddress || 'unknown',
        userAgent: requestMeta?.userAgent || 'unknown',
        status: 'SUCCESS',
      });

      logger.info(`✅ Exam created: ${exam.examId}`);
      return exam;
    } catch (error) {
      logger.error('Failed to create exam:', error);
      throw error;
    }
  }

  async getExams(filter?: any) {
    try {
      const query: any = {};

      if (filter?.status) query.status = filter.status;
      if (filter?.subject) query.subject = filter.subject;
      if (filter?.courseCode) query.courseCode = filter.courseCode;
      if (filter?.createdBy) query.createdBy = filter.createdBy;
      if (filter?.studentId) query.registeredStudents = filter.studentId;

      const exams = await Exam.find(query)
        .limit(filter?.limit || 50)
        .skip(filter?.skip || 0)
        .sort({ scheduledDate: -1 });

      const total = await Exam.countDocuments(query);

      return { exams, total };
    } catch (error) {
      logger.error('Failed to fetch exams:', error);
      throw error;
    }
  }

  async getExamById(examId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      return exam;
    } catch (error) {
      logger.error('Failed to fetch exam:', error);
      throw error;
    }
  }

  async updateExam(examId: string, updates: any, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      // Only the creator (faculty) can update
      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can update');
      }

      // Cannot update if exam is active or completed
      if (exam.status === 'ACTIVE' || exam.status === 'COMPLETED') {
        throw new BadRequestException('Cannot update active or completed exams');
      }

      if (updates.title != null) exam.title = updates.title;
      if (updates.description != null) exam.description = updates.description;
      if (updates.subject != null) exam.subject = updates.subject;
      if (updates.courseCode != null) exam.courseCode = updates.courseCode;
      if (updates.duration != null) {
        if (!ValidationUtils.validateExamDuration(updates.duration)) {
          throw new BadRequestException('Invalid exam duration');
        }
        exam.duration = Number(updates.duration);
      }
      if (updates.totalMarks != null && updates.passingMarks != null) {
        const totalMarks = Number(updates.totalMarks);
        const passingMarks = Number(updates.passingMarks);
        if (!ValidationUtils.validateMarks(passingMarks, totalMarks)) {
          throw new BadRequestException('Invalid marks configuration');
        }
        exam.totalMarks = totalMarks;
        exam.passingMarks = passingMarks;
      }
      if (updates.scheduledDate != null) exam.scheduledDate = updates.scheduledDate;

      await exam.save();

      logger.info(`✅ Exam updated: ${examId}`);
      return exam;
    } catch (error) {
      logger.error('Failed to update exam:', error);
      throw error;
    }
  }

  async registerStudents(examId: string, studentIds: string[], userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can register students');
      }

      // Add new students (avoid duplicates); tolerate null entries in DB
      const existingIds = normalizeStudentIdList(exam.registeredStudents);
      const incoming = normalizeStudentIdList(studentIds);
      const newStudents = incoming.filter((id) => !existingIds.includes(id));

      exam.registeredStudents = [...existingIds, ...newStudents];
      await exam.save();

      logger.info(`✅ ${newStudents.length} students registered for exam ${examId}`);
      return exam;
    } catch (error) {
      logger.error('Failed to register students:', error);
      throw error;
    }
  }

  async publishExam(examId: string, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can publish');
      }

      if (exam.status !== 'DRAFT') {
        throw new BadRequestException('Only draft exams can be published');
      }

      if (exam.questionCount === 0) {
        throw new BadRequestException('Cannot publish exam without questions');
      }

      exam.status = 'SCHEDULED';
      await exam.save();

      logger.info(`✅ Exam published: ${examId}`);
      return exam;
    } catch (error) {
      logger.error('Failed to publish exam:', error);
      throw error;
    }
  }

  async startExam(examId: string, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can start exam');
      }

      if (exam.status !== 'SCHEDULED') {
        throw new BadRequestException('Only scheduled exams can be started');
      }

      exam.status = 'ACTIVE';
      await exam.save();

      logger.info(`✅ Exam started: ${examId}`);
      return exam;
    } catch (error) {
      logger.error('Failed to start exam:', error);
      throw error;
    }
  }

  async endExam(examId: string, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can end exam');
      }

      if (exam.status !== 'ACTIVE') {
        throw new BadRequestException('Only active exams can be ended');
      }

      exam.status = 'COMPLETED';
      await exam.save();

      const activeSessions = await Session.find({ examId, status: { $in: ['STARTED', 'IN_PROGRESS'] } });
      const sessionResults = [] as Array<{ sessionId: string; resultId?: string; status: string }>;

      for (const session of activeSessions) {
        try {
          const finalized = await this.sessionService.endSessionByFaculty(
            String(session._id),
            String(userId),
            'Exam ended for all students'
          );
          sessionResults.push({
            sessionId: String(session._id),
            resultId: finalized.result?.resultId,
            status: 'ended',
          });
        } catch (error) {
          logger.error(`Failed to finalize session ${session._id} during exam end`, error);
          sessionResults.push({ sessionId: String(session._id), status: 'error' });
        }
      }

      const io = getSocketHub();
      if (io) {
        io.to(`exam:${examId}`).emit('exam:ended-by-faculty', {
          examId,
          reason: 'The invigilator has ended this examination for all students.',
        });
      }

      const terminalStatuses = ['SUBMITTED', 'FORCE_SUBMITTED', 'UFM_MARKED', 'ABANDONED', 'TIMEOUT'];
      const [sessionsStarted, sessionsSubmitted] = await Promise.all([
        Session.countDocuments({ examId, status: { $in: ['STARTED', 'IN_PROGRESS'] } }),
        Session.countDocuments({ examId, status: { $in: terminalStatuses } }),
      ]);
      const totalSessions = await Session.countDocuments({ examId });

      logger.info(`✅ Exam ended: ${examId}`);
      return {
        exam,
        summary: {
          totalSessions,
          sessionsStillActive: sessionsStarted,
          sessionsFinished: sessionsSubmitted,
          finalizedSessions: sessionResults,
        },
      };
    } catch (error) {
      logger.error('Failed to end exam:', error);
      throw error;
    }
  }

  async deleteExam(examId: string, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can delete');
      }

      if (exam.status === 'ACTIVE') {
        throw new BadRequestException('Cannot delete active exams');
      }

      await Exam.deleteOne({ _id: examId });

      logger.info(`✅ Exam deleted: ${examId}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete exam:', error);
      throw error;
    }
  }

  async addQuestion(examId: string, questionData: any, userId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      if (toIdString(exam.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can add questions');
      }

      // Normalize incoming fields to match Question schema
      const normalizeType = (t: any) => {
        if (!t) return t;
        const s = String(t).trim().toLowerCase();
        if (s === 'mcq') return 'MCQ';
        if (s === 'msq') return 'MSQ';
        if (s === 'short') return 'SHORT_ANSWER';
        if (s === 'short_answer' || s === 'short-answer') return 'SHORT_ANSWER';
        if (s === 'oneword' || s === 'one_word' || s === 'one-word') return 'ONE_WORD';
        if (s === 'image') return 'IMAGE';
        return s.toUpperCase();
      };

      const qText = questionData.questionText || questionData.question || '';
      const marks = typeof questionData.marks === 'number' ? questionData.marks : (questionData.marks ? Number(questionData.marks) : 1);
      const difficulty = questionData.difficulty ? String(questionData.difficulty).toUpperCase() : 'MEDIUM';
      const options = questionData.options || [];
      let correctAnswer = questionData.correctAnswer ?? questionData.correct ?? questionData.correctAnswers ?? null;

      const question = await Question.create({
        questionId: IdGenerator.generateUUID(),
        examId: examId,
        type: normalizeType(questionData.type),
        questionText: qText,
        marks,
        difficulty,
        topic: questionData.topic,
        options,
        correctAnswer,
        explanation: questionData.explanation,
        imageUrl: questionData.imageUrl,
        sequenceNumber: exam.questionCount + 1,
      });

      exam.questionCount = exam.questionCount + 1;
      await exam.save();

      logger.info(`✅ Question added to exam: ${examId}`);
      return question;
    } catch (error) {
      logger.error('Failed to add question:', error);
      throw error;
    }
  }

  async getQuestions(examId: string, includeSensitive = false) {
    try {
      const query = Question.find({ examId }).sort({ sequenceNumber: 1 });
      if (!includeSensitive) {
        query.select('-correctAnswer -explanation');
      }
      const questions = await query;

      return questions;
    } catch (error) {
      logger.error('Failed to fetch questions:', error);
      throw error;
    }
  }

  async updateQuestion(questionId: string, updates: any, userId: string) {
    try {
      const question = await Question.findById(questionId);

      if (!question) {
        throw new NotFoundException('Question not found');
      }

      const exam = await Exam.findById(question.examId);

      if (toIdString(exam?.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can update questions');
      }

      const normalizeType = (t: any) => {
        if (t == null) return t;
        const s = String(t).trim().toLowerCase();
        if (s === 'mcq') return 'MCQ';
        if (s === 'msq') return 'MSQ';
        if (s === 'short') return 'SHORT_ANSWER';
        if (s === 'short_answer' || s === 'short-answer') return 'SHORT_ANSWER';
        if (s === 'oneword' || s === 'one_word' || s === 'one-word') return 'ONE_WORD';
        if (s === 'image') return 'IMAGE';
        return s.toUpperCase();
      };

      if (updates.questionText != null || updates.question != null) question.questionText = updates.questionText ?? updates.question;
      if (updates.marks != null) question.marks = typeof updates.marks === 'number' ? updates.marks : Number(updates.marks);
      if (updates.type != null) question.type = normalizeType(updates.type);
      if (updates.options != null) question.options = updates.options;
      if (updates.correctAnswer !== undefined) question.correctAnswer = updates.correctAnswer;
      if (updates.explanation != null) question.explanation = updates.explanation;
      if (updates.imageUrl != null) question.imageUrl = updates.imageUrl;

      await question.save();

      logger.info(`✅ Question updated: ${questionId}`);
      return question;
    } catch (error) {
      logger.error('Failed to update question:', error);
      throw error;
    }
  }

  async deleteQuestion(questionId: string, userId: string) {
    try {
      const question = await Question.findById(questionId);

      if (!question) {
        throw new NotFoundException('Question not found');
      }

      const exam = await Exam.findById(question.examId);

      if (toIdString(exam?.createdBy) !== String(userId)) {
        throw new ForbiddenException('Only exam creator can delete questions');
      }

      await Question.deleteOne({ _id: questionId });

      // Decrement question count
      if (exam) {
        exam.questionCount = Math.max(0, exam.questionCount - 1);
        await exam.save();
      }

      logger.info(`✅ Question deleted: ${questionId}`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete question:', error);
      throw error;
    }
  }
}
