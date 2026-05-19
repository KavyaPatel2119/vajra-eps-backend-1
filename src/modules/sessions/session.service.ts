import { Session } from '../../database/schemas/session.schema';
import { Answer } from '../../database/schemas/answer.schema';
import { Exam } from '../../database/schemas/exam.schema';
import { Question } from '../../database/schemas/question.schema';
import { User } from '../../database/schemas/user.schema';
import { SurveillanceLog } from '../../database/schemas/surveillance-log.schema';
import { UFMReport } from '../../database/schemas/ufm-report.schema';
import { Result } from '../../database/schemas/result.schema';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConcurrentLoginException,
} from '../../common/exceptions/app.exceptions';
import { IdGenerator, ValidationUtils } from '../../common/utils/helpers';
import logger from '../../config/logger';
import { EncryptionService } from '../../config/encryption';
import { normalizeStudentIdList } from '../../common/utils/id-normalize';
import { getSocketHub } from '../../realtime/socket-hub';

export class SessionService {
  private encryptAnswerPayload(answer: any): string {
    return EncryptionService.encrypt(JSON.stringify(answer ?? null));
  }

  private decryptAnswerPayload(answer: any): any {
    if (typeof answer !== 'string' || !answer.includes(':')) {
      return answer;
    }

    try {
      return JSON.parse(EncryptionService.decrypt(answer));
    } catch {
      return answer;
    }
  }

  private answerTextFingerprint(answer: any): string {
    return EncryptionService.generateHash(JSON.stringify(answer ?? null));
  }

  private getLatestAnswersByQuestion(answerDocs: any[]) {
    const latestAnswers = new Map<string, any>();

    for (const answer of answerDocs) {
      const questionKey = String(answer.questionId || '');
      if (!questionKey) continue;

      const existing = latestAnswers.get(questionKey);
      if (!existing) {
        latestAnswers.set(questionKey, answer);
        continue;
      }

      const currentTime = new Date(answer.updatedAt || answer.submittedAt || answer.createdAt || 0).getTime();
      const existingTime = new Date(existing.updatedAt || existing.submittedAt || existing.createdAt || 0).getTime();
      if (currentTime >= existingTime) {
        latestAnswers.set(questionKey, answer);
      }
    }

    return Array.from(latestAnswers.values());
  }

  private async finalizeSessionResult(session: any) {
    const existingResult = await Result.findOne({ sessionId: session._id.toString() });
    if (existingResult) {
      return existingResult;
    }

    return this.calculateResults(session);
  }

  async startExamSession(examId: string, studentId: string, deviceInfo: any) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      const examStatus = String(exam.status || '').toUpperCase();
      if (examStatus !== 'ACTIVE') {
        throw new BadRequestException(
          'The examination has not begun yet. Your instructor must start the test before you can begin.'
        );
      }

      const studentIdStr = studentId != null ? String(studentId).trim() : '';
      if (!studentIdStr) {
        throw new BadRequestException('Invalid student identity');
      }

      const di = deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : {};
      const deviceId = di.deviceId != null ? String(di.deviceId) : `web-device-${Date.now()}`;
      const ipAddress = di.ipAddress != null ? String(di.ipAddress) : 'unknown';
      const userAgent = di.userAgent != null ? String(di.userAgent) : 'unknown';

      const regIds = normalizeStudentIdList(exam.registeredStudents);
      const isRegistered = regIds.length === 0 || regIds.includes(studentIdStr);

      if (!isRegistered) {
        throw new ForbiddenException('Student not registered for this exam');
      }

      // Prevent re-attempts: if student already has a completed/closed session or a result for this exam, block
      const completedSession = await Session.findOne({
        studentId: studentIdStr,
        examId,
        status: { $in: ['SUBMITTED', 'FORCE_SUBMITTED', 'UFM_MARKED'] },
      });

      const existingResult = await Result.findOne({ examId, studentId: studentIdStr });

      if (completedSession || existingResult) {
        throw new ForbiddenException('Exam already attempted or closed for this student');
      }

      // Check for concurrent sessions
      const activeSession = await Session.findOne({
        studentId: studentIdStr,
        examId,
        status: 'IN_PROGRESS',
      });

      if (activeSession) {
        const canResumeExistingSession =
          activeSession.deviceId === deviceId ||
          (activeSession.ipAddress === ipAddress && ipAddress !== 'unknown');

        if (canResumeExistingSession) {
          if (activeSession.deviceId !== deviceId) {
            activeSession.deviceId = deviceId;
            await activeSession.save();
          }
          logger.info(`Resuming active exam session: ${activeSession.sessionId}`);
          return activeSession;
        }

        // Trigger UFM for concurrent login
        await UFMReport.create({
          ufmId: IdGenerator.generateUUID(),
          studentId: studentIdStr,
          examId,
          sessionId: String(activeSession._id),
          reason: ['CONCURRENT_LOGIN'],
          severity: 'CRITICAL',
          evidence: [
            {
              type: 'CONCURRENT_LOGIN_DETECTED',
              description: `Concurrent login from device ${deviceId}`,
              data: { ...di, deviceId, ipAddress, userAgent },
              timestamp: new Date(),
            },
          ],
          isImmutable: true,
          status: 'OPEN',
        });

        throw new ConcurrentLoginException();
      }

      // Create new session
      const expiresAt = new Date(Date.now() + exam.duration * 60 * 1000);

      const session = await Session.create({
        sessionId: IdGenerator.generateSessionId(),
        examId: examId,
        studentId: studentIdStr,
        deviceId,
        ipAddress,
        startTime: new Date(),
        endTime: null,
        status: 'IN_PROGRESS',
        timeSpent: 0,
        totalQuestions: exam.questionCount,
        attemptedQuestions: 0,
        submittedQuestions: 0,
        expiresAt: expiresAt,
      });

      // Log session start
      await SurveillanceLog.create({
        logId: IdGenerator.generateUUID(),
        sessionId: String(session._id),
        studentId: studentIdStr,
        examId,
        eventType: 'EXAM_STARTED',
        severity: 'INFO',
        description: `Exam session started`,
        metadata: { ...di, userAgent },
        eventTime: new Date(),
      });

      logger.info(`✅ Session started: ${session.sessionId}`);
      
      // FIX #2: Auto-start screen sharing and recording for the student
      const io = getSocketHub();
      if (io) {
        // Emit event to trigger auto screen share for this student.
        // Broadcast to both session identifiers so legacy and Mongo-bound clients both receive it.
        const autoStartPayload = {
          sessionId: session.sessionId,
          sessionMongoId: String(session._id),
          examId,
          studentId: studentIdStr,
          message: 'Screen sharing will start automatically',
        };
        io.to(`session:${session.sessionId}`).emit('exam:auto-start-screen-share', autoStartPayload);
        io.to(`session:${session._id.toString()}`).emit('exam:auto-start-screen-share', autoStartPayload);
        logger.info(`📹 Auto-screen-share triggered for session: ${session.sessionId}`);
      }

      return session;
    } catch (error) {
      logger.error('Failed to start exam session:', error);
      throw error;
    }
  }

  async saveAnswer(sessionId: string, questionId: string, answer: any, markedForReview: boolean = false) {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      if (session.status !== 'IN_PROGRESS') {
        throw new BadRequestException('Session is not active');
      }

      const encryptedAnswer = this.encryptAnswerPayload(answer);
      const answerFingerprint = this.answerTextFingerprint(answer);

      // Check if answer already exists
      let existingAnswer = await Answer.findOne({
        sessionId: sessionId,
        questionId,
      });

      if (existingAnswer) {
        existingAnswer.answer = encryptedAnswer;
        existingAnswer.answerText = answerFingerprint;
        existingAnswer.markedForReview = markedForReview;
        existingAnswer.submittedAt = new Date();
        await existingAnswer.save();
      } else {
        existingAnswer = await Answer.create({
          answerId: IdGenerator.generateUUID(),
          sessionId: sessionId,
          questionId,
          studentId: session.studentId.toString(),
          answer: encryptedAnswer,
          answerText: answerFingerprint,
          markedForReview: markedForReview,
          submittedAt: new Date(),
        });

        session.attemptedQuestions += 1;
        await session.save();
      }

      logger.info(`✅ Answer saved: ${sessionId} - ${questionId}`);
      return existingAnswer;
    } catch (error) {
      logger.error('Failed to save answer:', error);
      throw error;
    }
  }

  async getSessionStatus(sessionId: string) {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      const answers = await Answer.find({ sessionId: sessionId });
      const totalTime = Date.now() - session.startTime.getTime();

      return {
        ...session.toObject(),
        timeSpentSeconds: Math.floor(totalTime / 1000),
        answersSubmitted: answers.length,
        answersReviewed: answers.filter(a => a.markedForReview).length,
      };
    } catch (error) {
      logger.error('Failed to get session status:', error);
      throw error;
    }
  }

  async submitExam(sessionId: string, answers?: any[]) {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      const terminalStatuses = ['SUBMITTED', 'FORCE_SUBMITTED', 'UFM_MARKED', 'ABANDONED', 'TIMEOUT'];
      if (session.status !== 'IN_PROGRESS' && !terminalStatuses.includes(session.status)) {
        throw new BadRequestException('Session is not active');
      }

      // Save any final answers
      if (answers && answers.length > 0) {
        for (const ans of answers) {
          await this.saveAnswer(sessionId, ans.questionId, ans.answer, ans.markedForReview);
        }
      }

      // Get all answers for this session
      const sessionAnswers = await Answer.find({ sessionId: sessionId });
      const latestSessionAnswers = this.getLatestAnswersByQuestion(sessionAnswers);

      if (session.status === 'IN_PROGRESS') {
        session.status = 'SUBMITTED';
        session.endTime = new Date();
        session.submittedQuestions = latestSessionAnswers.length;
        session.timeSpent = Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000);
        await session.save();
      }

      // Calculate results
      const result = await this.finalizeSessionResult(session);

      // Log submission
      await SurveillanceLog.create({
        logId: IdGenerator.generateUUID(),
        sessionId: String(sessionId),
        studentId: session.studentId.toString(),
        examId: session.examId.toString(),
        eventType: 'EXAM_SUBMITTED',
        severity: 'INFO',
        description: `Exam submitted with ${latestSessionAnswers.length} questions attempted`,
        metadata: {
          answerCount: latestSessionAnswers.length,
          attemptedQuestions: latestSessionAnswers.length,
          obtainedMarks: Number(result?.obtainedMarks ?? 0),
          totalMarks: Number(result?.totalMarks ?? 0),
          percentage: Number(result?.percentage ?? 0),
        },
        eventTime: new Date(),
      });

      logger.info(`✅ Exam submitted: ${sessionId}`);
      return result;
    } catch (error) {
      logger.error('Failed to submit exam:', error);
      throw error;
    }
  }

  private async calculateResults(session: any) {
      const exam = await Exam.findById(session.examId);
      const answers = await Answer.find({ sessionId: session._id.toString() });
      const uniqueAnswers = this.getLatestAnswersByQuestion(answers);
      const examQuestions = await Question.find({ examId: session.examId }).lean();
      let examTotalMarks = 0;
      if (examQuestions.length > 0) {
        examTotalMarks = examQuestions.reduce((sum, question) => {
          const marks = typeof question.marks === 'number' && Number.isFinite(question.marks) ? question.marks : 1;
          return sum + marks;
        }, 0);
      }

    let totalObtained = 0;
    let correctCount = 0;
    let percentage = 0;
    let grade = 'F';
    let isPassed = false;
    let resultStatus = 'FAIL';

    // If exam was force-submitted by faculty, automatically mark as FAIL with 0 marks
    if (session.status === 'FORCE_SUBMITTED') {
      totalObtained = 0;
      correctCount = 0;
      percentage = 0;
      grade = 'F';
      isPassed = false;
      resultStatus = 'FAIL';
      
      logger.warn(`⚠️ Force-submitted exam: ${session._id} marked as FAIL`);
    } else {
      const validQuestionIds = new Set(examQuestions.map(q => q._id.toString()));

      // Normal exam submission - calculate based on answers
      // ONLY count answers for questions that belong to this exam
      for (const answer of uniqueAnswers) {
        // Skip answers for questions not in this exam
        if (!validQuestionIds.has(answer.questionId.toString())) {
          logger.debug(`Skipping orphaned answer: ${answer.questionId} not in exam ${session.examId}`);
          continue;
        }

        const isCorrect = await this.validateAnswer(this.decryptAnswerPayload(answer.answer), answer.questionId);
        answer.isCorrect = isCorrect;
        const q = examQuestions.find(eq => eq._id.toString() === answer.questionId.toString());
        const marks = q && typeof q.marks === 'number' ? q.marks : 1;
        if (isCorrect) {
          totalObtained += marks;
          correctCount++;
        }
        await answer.save();
      }

      const totalPossibleMarks = examTotalMarks > 0 ? examTotalMarks : exam?.totalMarks || 0;
      percentage = totalPossibleMarks > 0 ? (totalObtained / totalPossibleMarks) * 100 : 0;
      grade = ValidationUtils.getGrade(percentage);
      const passingMarks = exam?.passingMarks && exam?.passingMarks > 0 ? exam.passingMarks : Math.ceil(totalPossibleMarks * 0.4);
      isPassed = totalPossibleMarks > 0 ? totalObtained >= passingMarks : false;
      resultStatus = isPassed ? 'PASS' : 'FAIL';
    }

    const result = await Result.create({
      resultId: IdGenerator.generateUUID(),
      examId: session.examId,
      studentId: session.studentId,
      sessionId: session._id.toString(),
      totalMarks: examTotalMarks > 0 ? examTotalMarks : exam?.totalMarks || 0,
      obtainedMarks: totalObtained,
      percentage: percentage,
      grade: grade,
      status: resultStatus,
      resultPublishedAt: new Date(),
    });

    // FIX #3: Emit socket event to notify faculty of student submission with marks
    const io = getSocketHub();
    if (io && exam) {
      io.to(`exam:${session.examId}:faculty`).emit('exam:student-result-ready', {
        examId: session.examId,
        studentId: session.studentId,
        resultId: result.resultId,
        obtainedMarks: totalObtained,
        totalMarks: examTotalMarks > 0 ? examTotalMarks : exam.totalMarks,
        percentage: Math.round(percentage * 100) / 100,
        grade: grade,
        status: resultStatus,
        timestamp: new Date(),
      });
      logger.info(`📢 Faculty notified of result: ${result.resultId}`);
    }

    return result;
  }

  private async validateAnswer(answer: any, questionId: string): Promise<boolean> {
    try {
      const q: any = await Question.findById(questionId).lean();
      if (!q) return false;
      const correct = q.correctAnswer;
      const type = String(q.type || 'MCQ').toUpperCase();
      const options: any[] = Array.isArray(q.options) ? q.options : [];
      const opts = options;

      const optionText = (option: any) => {
        if (typeof option === 'string') return option;
        if (option && typeof option === 'object') return String(option.text ?? option.label ?? option.value ?? '');
        return String(option ?? '');
      };

      const normalizeText = (value: any) => String(value ?? '').trim().toLowerCase();

      const resolveSelectedText = (selectedAnswer: any) => {
        if (selectedAnswer == null) return '';
        if (typeof selectedAnswer === 'number' && Number.isFinite(selectedAnswer)) {
          return optionText(options[selectedAnswer] ?? '');
        }
        if (typeof selectedAnswer === 'string') {
          const trimmed = selectedAnswer.trim();
          if (/^-?\d+$/.test(trimmed) && options.length > 0) {
            const index = Number(trimmed);
            return optionText(options[index] ?? trimmed);
          }
          return trimmed;
        }
        return optionText(selectedAnswer);
      };

      const normalizeCorrectChoices = (value: any) => {
        if (Array.isArray(value)) {
          return value
            .map((item: any) => resolveSelectedText(item))
            .filter(Boolean)
            .map(normalizeText)
            .sort();
        }

        const resolved = resolveSelectedText(value);
        return resolved ? [normalizeText(resolved)] : [];
      };

      const normalizeSelectedChoices = (value: any) => {
        const rawChoices = Array.isArray(value)
          ? value
          : Array.isArray(value?.choices)
            ? value.choices
            : Array.isArray(value?.selectedAnswers)
              ? value.selectedAnswers
              : Array.isArray(value?.selectedIndices)
                ? value.selectedIndices
                : Array.isArray(value?.choice)
                  ? value.choice
                  : value?.choice != null
                    ? [value.choice]
                    : [];

        return rawChoices
          .map((item: any) => resolveSelectedText(item))
          .filter(Boolean)
          .map(normalizeText)
          .sort();
      };

      if (type === 'MCQ' || type === 'ONE_WORD') {
        const choiceIdx =
          typeof answer?.choice === 'number' ? answer.choice : Number.parseInt(String(answer?.choice), 10);
        const selectedText = resolveSelectedText(choiceIdx);

        if (typeof correct === 'number' && Number.isFinite(correct)) {
          return choiceIdx === correct;
        }
        if (Array.isArray(correct)) {
          const selected = normalizeSelectedChoices([choiceIdx]);
          const expected = normalizeCorrectChoices(correct);
          return (
            selected.length > 0 &&
            selected.length === expected.length &&
            selected.every((item: string, index: number) => item === expected[index])
          );
        }
        if (typeof correct === 'string' && selectedText) {
          return normalizeText(correct) === normalizeText(selectedText);
        }
        const correctStr = correct != null ? String(correct).trim() : '';
        if (correctStr && opts.length) {
          const cIdx = opts.findIndex((o: any) => {
            const t = typeof o === 'string' ? o : String(o?.text ?? '');
            return t.trim() === correctStr;
          });
          return Number.isFinite(choiceIdx) && cIdx === choiceIdx;
        }
      }

      if (type === 'MSQ') {
        const selected = normalizeSelectedChoices(answer);
        const expected = normalizeCorrectChoices(correct);

        if (selected.length === 0 || expected.length === 0) return false;
        return selected.length === expected.length && selected.every((item: string, index: number) => item === expected[index]);
      }

      if (type === 'SHORT_ANSWER' || type === 'ESSAY' || type === 'NUMERIC' || type === 'ONE_WORD') {
        const selectedValue =
          answer?.text ?? answer?.answerText ?? answer?.response ?? answer?.value ?? answer?.choice ?? answer;

        if (selectedValue == null || correct == null) return false;

        const selectedText = String(selectedValue).trim();
        const correctText = String(correct).trim();

        if (!selectedText || !correctText) return false;

        const selectedNumber = Number(selectedText);
        const correctNumber = Number(correctText);
        if (Number.isFinite(selectedNumber) && Number.isFinite(correctNumber)) {
          return selectedNumber === correctNumber;
        }

        return normalizeText(selectedText) === normalizeText(correctText);
      }

      if (answer?.text != null && correct != null) {
        return normalizeText(answer.text) === normalizeText(correct);
      }

      return false;
    } catch {
      return false;
    }
  }

  async endSession(sessionId: string) {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      if (session.status === 'SUBMITTED') {
        return session;
      }

      session.status = 'ABANDONED';
      session.endTime = new Date();
      session.timeSpent = Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000);
      await session.save();

      logger.info(`✅ Session ended: ${sessionId}`);
      return session;
    } catch (error) {
      logger.error('Failed to end session:', error);
      throw error;
    }
  }

  async getSessionAnswers(sessionId: string) {
    try {
      const answers = await Answer.find({ sessionId: sessionId });
      return answers;
    } catch (error) {
      logger.error('Failed to fetch answers:', error);
      throw error;
    }
  }

  async endSessionByFaculty(sessionId: string, facultyId: string, reason: string = 'Exam ended by faculty') {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      // If already submitted, just return the existing result
      if (session.status === 'SUBMITTED' || session.status === 'FORCE_SUBMITTED' || session.status === 'UFM_MARKED') {
        const existingResult = await Result.findOne({ sessionId: sessionId });
        if (existingResult) {
          return { session, result: existingResult };
        }
      }

      // Mark session as SUBMITTED (not abandoned)
      session.status = 'SUBMITTED';
      session.endTime = new Date();
      
      // Get all answers for this session
      const sessionAnswers = await Answer.find({ sessionId: sessionId });
      const latestSessionAnswers = this.getLatestAnswersByQuestion(sessionAnswers);
      session.submittedQuestions = latestSessionAnswers.length;
      session.timeSpent = Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000);
      
      await session.save();

      // Calculate results
      const result = await this.finalizeSessionResult(session);

      // Log the faculty action
      await SurveillanceLog.create({
        logId: IdGenerator.generateUUID(),
        sessionId: String(sessionId),
        studentId: session.studentId.toString(),
        examId: session.examId.toString(),
        eventType: 'EXAM_ENDED_BY_FACULTY',
        severity: 'INFO',
        description: `Exam ended by faculty: ${reason}`,
        metadata: {
          facultyId,
          reason,
          attemptedQuestions: latestSessionAnswers.length,
          obtainedMarks: Number(result?.obtainedMarks ?? 0),
          totalMarks: Number(result?.totalMarks ?? 0),
          percentage: Number(result?.percentage ?? 0),
        },
        eventTime: new Date(),
      });

      logger.info(`✅ Session ended by faculty with results calculated: ${sessionId}`);
      return { session, result };
    } catch (error) {
      logger.error('Failed to end session by faculty:', error);
      throw error;
    }
  }

  async forceSubmitByFaculty(sessionId: string, facultyId: string, reason: string) {
    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      if (session.status === 'SUBMITTED') {
        const existingResult = await Result.findOne({ sessionId: sessionId });
        if (existingResult) {
          return { session, result: existingResult };
        }
      }

      const sessionAnswers = await Answer.find({ sessionId: sessionId });
      const latestSessionAnswers = this.getLatestAnswersByQuestion(sessionAnswers);
      session.status = 'FORCE_SUBMITTED';
      session.endTime = new Date();
      session.forceSubmitReason = reason;
      session.forcedByFaculty = true;
      session.submittedQuestions = latestSessionAnswers.length;
      session.timeSpent = Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000);
      await session.save();

      const result = await this.finalizeSessionResult(session);

      await SurveillanceLog.create({
        logId: IdGenerator.generateUUID(),
        sessionId: String(sessionId),
        studentId: session.studentId.toString(),
        examId: session.examId.toString(),
        eventType: 'FORCE_SUBMITTED_BY_FACULTY',
        severity: 'CRITICAL',
        description: `Exam force-submitted by faculty: ${reason}`,
        metadata: {
          facultyId,
          reason,
          attemptedQuestions: latestSessionAnswers.length,
          obtainedMarks: Number(result?.obtainedMarks ?? 0),
          totalMarks: Number(result?.totalMarks ?? 0),
          percentage: Number(result?.percentage ?? 0),
        },
        eventTime: new Date(),
      });

      logger.info(`✅ Session force-submitted by faculty with result calculated: ${sessionId}`);
      return { session, result };
    } catch (error) {
      logger.error('Failed to force submit session by faculty:', error);
      throw error;
    }
  }
}
