import { Result } from '../../database/schemas/result.schema';
import { Session } from '../../database/schemas/session.schema';
import { Answer } from '../../database/schemas/answer.schema';
import { Exam } from '../../database/schemas/exam.schema';
import { Question } from '../../database/schemas/question.schema';
import { User } from '../../database/schemas/user.schema';
import { NotFoundException } from '../../common/exceptions/app.exceptions';
import logger from '../../config/logger';

export class ResultService {
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

  private getOptionText(question: any, value: unknown): string {
    if (value == null) return '—';
    const options = Array.isArray(question?.options) ? question.options : [];

    const renderOption = (opt: any) => {
      if (typeof opt === 'string') return opt;
      if (opt && typeof opt === 'object') return String(opt.text ?? opt.label ?? opt.value ?? '');
      return String(opt ?? '');
    };

    if (typeof value === 'number' && Number.isInteger(value) && options[value] != null) {
      return renderOption(options[value]);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') {
        const index = Number(trimmed);
        if (Number.isInteger(index) && options[index] != null) {
          return renderOption(options[index]);
        }
      }
      return trimmed || '—';
    }

    return String(value);
  }

  private extractSubmittedAnswer(answer: any): unknown {
    if (answer == null) return null;
    if (Array.isArray(answer)) return answer;
    if (typeof answer !== 'object') return answer;
    if (Object.prototype.hasOwnProperty.call(answer, 'choice')) return answer.choice;
    if (Object.prototype.hasOwnProperty.call(answer, 'choices')) return answer.choices;
    if (Object.prototype.hasOwnProperty.call(answer, 'text')) return answer.text;
    if (Object.prototype.hasOwnProperty.call(answer, 'value')) return answer.value;
    return answer;
  }

  private formatSubmittedAnswer(answer: any, question: any): string {
    const raw = this.extractSubmittedAnswer(answer);
    if (Array.isArray(raw)) {
      if (raw.length === 0) return '—';
      return raw.map((v) => this.getOptionText(question, v)).join(', ');
    }
    return this.getOptionText(question, raw);
  }

  private formatCorrectAnswer(question: any): string {
    const raw = question?.correctAnswer;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return '—';
      return raw.map((v) => this.getOptionText(question, v)).join(', ');
    }
    return this.getOptionText(question, raw);
  }

  private inferQuestionTopic(question: any): string {
    const explicit = String(question?.topic || '').trim();
    if (explicit && explicit.toLowerCase() !== 'general') return explicit;

    const text = String(question?.questionText || question?.question || '').toLowerCase();
    const buckets: Array<[string, string[]]> = [
      ['Algorithms', ['algorithm', 'search', 'sort', 'tree', 'graph', 'complexity', 'heuristic', 'breadth', 'depth']],
      ['Artificial Intelligence', ['intelligent', 'ai', 'agent', 'knowledge', 'reasoning', 'learning', 'neural']],
      ['Database Systems', ['database', 'sql', 'normalization', 'transaction', 'schema', 'query', 'table']],
      ['Operating Systems', ['process', 'thread', 'memory', 'deadlock', 'scheduling', 'kernel']],
      ['Computer Networks', ['network', 'tcp', 'ip', 'router', 'packet', 'protocol', 'dns', 'http']],
      ['Programming Concepts', ['code', 'program', 'function', 'class', 'object', 'variable', 'loop']],
      ['Mathematics', ['matrix', 'probability', 'calculus', 'algebra', 'equation', 'number']],
    ];

    const matched = buckets.find(([, words]) => words.some((word) => text.includes(word)));
    if (matched) return matched[0];

    const keywords = text
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !['which', 'following', 'mentioned', 'course', 'syllabus', 'explicitly'].includes(word));

    if (keywords.length > 0) {
      return keywords.slice(0, 2).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }

    return 'Concept Review';
  }

  private buildTopicWiseFromAnswers(uniqueAnswers: any[], questionById: Map<string, any>) {
    const agg = new Map<string, { topic: string; score: number; total: number }>();

    for (const answer of uniqueAnswers) {
      const q = questionById.get(String(answer.questionId));
      if (!q) continue;
      const topic = this.inferQuestionTopic(q);
      const marks = Number.isFinite(Number(q.marks)) ? Number(q.marks) : 1;
      const entry = agg.get(topic) || { topic, score: 0, total: 0 };
      entry.total += marks;
      if (answer.isCorrect === true) {
        entry.score += marks;
      }
      agg.set(topic, entry);
    }

    return Array.from(agg.values()).map((t) => ({
      topic: t.topic,
      score: t.score,
      total: t.total,
      percentage: t.total > 0 ? Math.round((t.score / t.total) * 10000) / 100 : 0,
    }));
  }

  private computeRank(results: any[], currentResultId: string): { rank: number | null; totalParticipants: number } {
    if (!Array.isArray(results) || results.length === 0) {
      return { rank: null, totalParticipants: 0 };
    }

    const sorted = [...results].sort((a, b) => Number(b.obtainedMarks || 0) - Number(a.obtainedMarks || 0));
    let rank = 0;
    let previousScore: number | null = null;

    for (let i = 0; i < sorted.length; i += 1) {
      const score = Number(sorted[i].obtainedMarks || 0);
      if (previousScore === null || score < previousScore) {
        rank = i + 1;
        previousScore = score;
      }
      if (String(sorted[i]._id) === currentResultId) {
        return { rank, totalParticipants: sorted.length };
      }
    }

    return { rank: null, totalParticipants: sorted.length };
  }

  async getResult(resultId: string) {
    try {
      const result = await Result.findOne({ resultId });

      if (!result) {
        throw new NotFoundException('Result not found');
      }

      return result;
    } catch (error) {
      logger.error('Failed to fetch result:', error);
      throw error;
    }
  }

  async getStudentResults(studentId: string, filter?: any) {
    try {
      const query: any = { studentId };

      if (filter?.examId) query.examId = filter.examId;
      if (filter?.status) query.status = filter.status;

      const results = await Result.find(query)
        .limit(filter?.limit || 50)
        .skip(filter?.skip || 0)
        .sort({ resultPublishedAt: -1 });

      const total = await Result.countDocuments(query);

      return { results, total };
    } catch (error) {
      logger.error('Failed to fetch student results:', error);
      throw error;
    }
  }

  /** Shapes results for the student web app (exam title, score labels, safe dates). */
  async getStudentResultsEnriched(studentId: string, filter?: any) {
    const { results, total } = await this.getStudentResults(studentId, filter);

    const out = await Promise.all(results.map(async (r) => {
      const [exam, session, answerDocs, allExamResults] = await Promise.all([
        Exam.findById(r.examId).lean(),
        Session.findById(r.sessionId).lean(),
        Answer.find({ sessionId: r.sessionId }),
        Result.find({ examId: r.examId }).select('_id obtainedMarks').lean(),
      ]);
      const uniqueAnswers = this.getLatestAnswersByQuestion(answerDocs);
      const correctAnswers = uniqueAnswers.filter((a) => a.isCorrect === true).length;
      const attempted = uniqueAnswers.length;

      const questionIds = uniqueAnswers.map((a) => String(a.questionId)).filter(Boolean);
      const questionDocs = questionIds.length > 0 ? await Question.find({ _id: { $in: questionIds } }).lean() : [];
      const questionById = new Map<string, any>(questionDocs.map((q) => [String(q._id), q]));

      const answerReview = uniqueAnswers
        .map((a) => {
          const q = questionById.get(String(a.questionId));
          return {
            questionId: String(a.questionId || ''),
            questionText: q?.questionText || 'Question text unavailable',
            questionType: q?.type || 'MCQ',
            topic: this.inferQuestionTopic(q),
            marks: Number.isFinite(Number(q?.marks)) ? Number(q.marks) : 1,
            studentAnswer: this.formatSubmittedAnswer(a.answer, q),
            correctAnswer: this.formatCorrectAnswer(q),
            solution: q?.explanation || 'No solution provided.',
            isCorrect: a.isCorrect === true,
          };
        })
        .sort((a, b) => {
          const qa = questionById.get(a.questionId);
          const qb = questionById.get(b.questionId);
          const sa = Number(qa?.sequenceNumber || 0);
          const sb = Number(qb?.sequenceNumber || 0);
          return sa - sb;
        });

      const savedTopicWise = Array.isArray(r.topicWiseAnalysis)
        ? r.topicWiseAnalysis.map((t: any) => {
            const score = Number(t?.marksObtained ?? t?.score ?? 0);
            const totalMarks = Number(t?.totalMarks ?? t?.total ?? 0);
            const percentage = Number.isFinite(Number(t?.percentage))
              ? Number(t.percentage)
              : totalMarks > 0
                ? Math.round((score / totalMarks) * 10000) / 100
                : 0;
            return {
              topic: t?.topic || 'General',
              score,
              total: totalMarks,
              percentage,
            };
          })
        : [];
      const derivedTopicWise = this.buildTopicWiseFromAnswers(uniqueAnswers, questionById);
      const hasSpecificSavedTopics = savedTopicWise.some((t: any) => String(t.topic || '').toLowerCase() !== 'general');
      const topicWise = savedTopicWise.length > 0 && hasSpecificSavedTopics ? savedTopicWise : derivedTopicWise;

      const ranking = this.computeRank(allExamResults, String(r._id));

      const published = r.resultPublishedAt || (r as any).createdAt;
      const timeSpentSec = session?.timeSpent != null ? Number(session.timeSpent) : 0;

      return {
        resultId: r.resultId,
        examId: r.examId,
        examName: (exam as any)?.title || (exam as any)?.subject || 'Examination',
        date: published,
        score: r.obtainedMarks,
        totalMarks: r.totalMarks,
        percentage: Math.round(r.percentage * 100) / 100,
        rank: ranking.rank ?? (ranking.totalParticipants === 1 ? 1 : null),
        totalParticipants: ranking.totalParticipants,
        timeTaken: Math.max(0, Math.round(timeSpentSec / 60)),
        timeTakenSeconds: timeSpentSec,
        status: r.status,
        grade: r.grade,
        details: {
          totalQuestions: Number((exam as any)?.questionCount ?? answerReview.length),
          attemptedQuestions: attempted,
          correctAnswers,
          wrongAnswers: Math.max(0, attempted - correctAnswers),
          topicWise,
          answerReview,
        },
      };
    }));

    return { results: out, total };
  }

  async getExamResults(examId: string) {
    try {
      const results = await Result.find({ examId })
        .sort({ resultPublishedAt: -1 });

      // Calculate statistics
      const stats = {
        totalAttempts: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        averageMarks: results.length > 0 ? results.reduce((sum, r) => sum + r.obtainedMarks, 0) / results.length : 0,
        averagePercentage: results.length > 0 ? results.reduce((sum, r) => sum + r.percentage, 0) / results.length : 0,
        highestMarks: results.length > 0 ? Math.max(...results.map(r => r.obtainedMarks)) : 0,
        lowestMarks: results.length > 0 ? Math.min(...results.map(r => r.obtainedMarks)) : 0,
      };

      return { results, stats };
    } catch (error) {
      logger.error('Failed to fetch exam results:', error);
      throw error;
    }
  }

  // FIX #4: Get student marks for an exam with filtering and sorting for Faculty Dashboard
  async getStudentMarksForExam(examId: string, options: any = {}) {
    try {
      const { limit = 20, skip = 0, studentName, sortBy = 'obtainedMarks', sortOrder = -1 } = options;

      let query: any = { examId };

      // Get results
      const sortObj: any = {};
      sortObj[sortBy] = sortOrder;

      const results = await Result.find(query)
        .sort(sortObj)
        .limit(limit)
        .skip(skip)
        .lean();

      // Enrich with student info
      const marks = [];
      for (const result of results) {
        // Try to resolve the student document by several possible identifiers
        const student = await User.findOne({
          $or: [
            { _id: result.studentId },
            { studentId: result.studentId },
            { email: result.studentId },
          ],
        }).lean();

        const studentName = student
          ? `${(student as any).firstName || ''} ${(student as any).lastName || ''}`.trim() || (student as any).email || 'Unknown'
          : 'Unknown';

        marks.push({
          resultId: result.resultId,
          studentObjectId: student?._id || null,
          studentId: student?.studentId || result.studentId,
          studentName,
          studentEmail: (student as any)?.email || '-',
          obtainedMarks: result.obtainedMarks,
          totalMarks: result.totalMarks,
          percentage: Math.round(result.percentage * 100) / 100,
          grade: result.grade,
          status: result.status,
          submittedAt: result.createdAt,
        });
      }

      const total = await Result.countDocuments(query);

      return { marks, total };
    } catch (error) {
      logger.error('Failed to fetch student marks for exam:', error);
      throw error;
    }
  }

  async publishResults(examId: string) {
    try {
      const exam = await Exam.findById(examId);

      if (!exam) {
        throw new NotFoundException('Exam not found');
      }

      const results = await Result.find({ examId, resultPublishedAt: null });

      for (const result of results) {
        result.resultPublishedAt = new Date();
        await result.save();
      }

      logger.info(`✅ Results published for exam: ${examId}`);
      return { published: results.length };
    } catch (error) {
      logger.error('Failed to publish results:', error);
      throw error;
    }
  }

  async getDetailedResult(resultId: string) {
    try {
      const result = await Result.findOne({ resultId });

      if (!result) {
        throw new NotFoundException('Result not found');
      }

      const session = await Session.findById(result.sessionId);
      const answers = await Answer.find({ sessionId: result.sessionId });
      const uniqueAnswers = this.getLatestAnswersByQuestion(answers);

      return {
        ...result.toObject(),
        session,
        answers,
        answerCount: uniqueAnswers.length,
        correctCount: uniqueAnswers.filter(a => a.isCorrect).length,
      };
    } catch (error) {
      logger.error('Failed to fetch detailed result:', error);
      throw error;
    }
  }

  async getTopicsAnalysis(resultId: string) {
    try {
      const result = await Result.findOne({ resultId });

      if (!result) {
        throw new NotFoundException('Result not found');
      }

      const answers = await Answer.find({ sessionId: result.sessionId });

      // Group by topic
      const topicAnalysis: any = {};

      for (const answer of answers) {
        // Would need question schema to get topic
        // This is simplified
        if (!topicAnalysis[answer.questionId]) {
          topicAnalysis[answer.questionId] = {
            attempted: 0,
            correct: 0,
            percentage: 0,
          };
        }
        topicAnalysis[answer.questionId].attempted++;
        if (answer.isCorrect) topicAnalysis[answer.questionId].correct++;
        topicAnalysis[answer.questionId].percentage = (topicAnalysis[answer.questionId].correct / topicAnalysis[answer.questionId].attempted) * 100;
      }

      return topicAnalysis;
    } catch (error) {
      logger.error('Failed to analyze topics:', error);
      throw error;
    }
  }
}
