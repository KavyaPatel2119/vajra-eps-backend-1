import { Schema, model, Document } from 'mongoose';

export interface ISurveillanceLog extends Document {
  _id: string;
  logId: string;
  sessionId: string;
  studentId: string;
  examId: string;
  eventType:
    | 'EXAM_STARTED'
    | 'EXAM_SUBMITTED'
    | 'TAB_SWITCH'
    | 'APP_SWITCH'
    | 'WINDOW_BLUR'
    | 'MULTI_FACE'
    | 'FACE_ABSENT'
    | 'MOUSE_LEFT_SCREEN'
    | 'PROCESS_DETECTED'
    | 'USB_DETECTED'
    | 'SCREEN_SHARE_DETECTED'
    | 'COPY_PASTE_DETECTED'
    | 'SCREEN_FROZEN_BY_FACULTY'
    | 'SCREEN_UNFROZEN_BY_FACULTY'
    | 'FORCE_SUBMITTED_BY_FACULTY'
    | 'WARNING_SENT_BY_FACULTY'
    | 'UFM_MARKED_BY_FACULTY';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  description: string;
  metadata: Record<string, any>;
  eventTime: Date;
  screenshotUrl?: string;
  createdAt: Date;
}

const surveillanceLogSchema = new Schema<ISurveillanceLog>(
  {
    logId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    studentId: { type: String, required: true },
    examId: { type: String, required: true },
    eventType: {
      type: String,
      enum: [
        'EXAM_STARTED',
        'EXAM_SUBMITTED',
        'TAB_SWITCH',
        'APP_SWITCH',
        'WINDOW_BLUR',
        'MULTI_FACE',
        'FACE_ABSENT',
        'MOUSE_LEFT_SCREEN',
        'PROCESS_DETECTED',
        'USB_DETECTED',
        'SCREEN_SHARE_DETECTED',
        'COPY_PASTE_DETECTED',
        'SCREEN_FROZEN_BY_FACULTY',
        'SCREEN_UNFROZEN_BY_FACULTY',
        'FORCE_SUBMITTED_BY_FACULTY',
        'WARNING_SENT_BY_FACULTY',
        'UFM_MARKED_BY_FACULTY',
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ['INFO', 'WARNING', 'CRITICAL'],
      default: 'INFO',
    },
    description: { type: String, required: true },
    metadata: Schema.Types.Mixed,
    eventTime: { type: Date, required: true },
    screenshotUrl: String,
  },
  { timestamps: true }
);

surveillanceLogSchema.index({ sessionId: 1 });
surveillanceLogSchema.index({ eventType: 1, eventTime: 1 });
surveillanceLogSchema.index({ studentId: 1 });

export const SurveillanceLog = model<ISurveillanceLog>(
  'SurveillanceLog',
  surveillanceLogSchema
);
