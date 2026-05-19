import { SurveillanceLog } from '../../database/schemas/surveillance-log.schema';
import { NotFoundException } from '../../common/exceptions/app.exceptions';
import { IdGenerator } from '../../common/utils/helpers';
import logger from '../../config/logger';

export class SurveillanceService {
  async createLog(data: any) {
    try {
      const log = await SurveillanceLog.create({
        logId: IdGenerator.generateUUID(),
        sessionId: data.sessionId,
        studentId: data.studentId,
        examId: data.examId,
        eventType: data.eventType,
        severity: data.severity || 'INFO',
        description: data.description,
        metadata: data.metadata || {},
        screenshotUrl: data.screenshotUrl,
        eventTime: new Date(),
      });

      logger.debug(`📝 Surveillance log created: ${log.logId}`);
      return log;
    } catch (error) {
      logger.error('Failed to create surveillance log:', error);
      throw error;
    }
  }

  async getSessionLogs(sessionId: string) {
    try {
      const logs = await SurveillanceLog.find({ sessionId }).sort({ eventTime: -1 });

      return logs;
    } catch (error) {
      logger.error('Failed to fetch session logs:', error);
      throw error;
    }
  }

  async getStudentLogs(studentId: string, examId?: string) {
    try {
      const query: any = { studentId };

      if (examId) query.examId = examId;

      const logs = await SurveillanceLog.find(query)
        .limit(1000)
        .sort({ eventTime: -1 });

      return logs;
    } catch (error) {
      logger.error('Failed to fetch student logs:', error);
      throw error;
    }
  }

  async getExamLogs(examId: string, filter?: any) {
    try {
      const query: any = { examId };

      if (filter?.eventType) query.eventType = filter.eventType;
      if (filter?.severity) query.severity = filter.severity;
      if (filter?.studentId) query.studentId = filter.studentId;

      const logs = await SurveillanceLog.find(query)
        .limit(filter?.limit || 500)
        .skip(filter?.skip || 0)
        .sort({ eventTime: -1 });

      const total = await SurveillanceLog.countDocuments(query);

      return { logs, total };
    } catch (error) {
      logger.error('Failed to fetch exam logs:', error);
      throw error;
    }
  }

  async getSuspiciousActivities(examId: string) {
    try {
      const suspiciousEvents = [
        'TAB_SWITCH',
        'APP_SWITCH',
        'WINDOW_BLUR',
        'MULTI_FACE',
        'FACE_ABSENT',
        'COPY_PASTE_DETECTED',
        'UNAUTHORIZED_PROCESS',
        'SCREEN_SHARE_DETECTED',
      ];

      const logs = await SurveillanceLog.find({
        examId,
        eventType: { $in: suspiciousEvents },
      }).sort({ eventTime: -1 });

      // Group by severity
      const bySeverity = {
        CRITICAL: logs.filter(l => l.severity === 'CRITICAL'),
        WARNING: logs.filter(l => l.severity === 'WARNING'),
        INFO: logs.filter(l => l.severity === 'INFO'),
      };

      return bySeverity;
    } catch (error) {
      logger.error('Failed to fetch suspicious activities:', error);
      throw error;
    }
  }

  async getActivityStats(examId: string) {
    try {
      const logs = await SurveillanceLog.find({ examId });

      const stats = {
        totalEvents: logs.length,
        byEventType: {} as any,
        bySeverity: {
          CRITICAL: logs.filter(l => l.severity === 'CRITICAL').length,
          WARNING: logs.filter(l => l.severity === 'WARNING').length,
          INFO: logs.filter(l => l.severity === 'INFO').length,
        },
        byStudent: {} as any,
      };

      // Count by event type
      for (const log of logs) {
        stats.byEventType[log.eventType] = (stats.byEventType[log.eventType] || 0) + 1;
      }

      // Count by student
      for (const log of logs) {
        const studentId = log.studentId.toString();
        stats.byStudent[studentId] = (stats.byStudent[studentId] || 0) + 1;
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get activity stats:', error);
      throw error;
    }
  }
}
