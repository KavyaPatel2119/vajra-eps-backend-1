import { Schema, model, Document } from 'mongoose';

export interface ISession extends Document {
  _id: string;
  sessionId: string;
  examId: string;
  studentId: string;
  deviceId: string;
  ipAddress: string;
  startTime: Date;
  endTime?: Date;
  status: 'STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'ABANDONED' | 'TIMEOUT' | 'FORCE_SUBMITTED' | 'UFM_MARKED';
  timeSpent: number; // in seconds
  totalQuestions: number;
  attemptedQuestions: number;
  submittedQuestions: number;
  isFrozen?: boolean;
  freezeReason?: string | null;
  forceSubmitReason?: string | null;
  forcedByFaculty?: boolean;
  ufmMarkedAt?: Date;
  ufmReason?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    sessionId: { type: String, required: true, unique: true },
    examId: { type: String, required: true },
    studentId: { type: String, required: true },
    deviceId: { type: String, required: true },
    ipAddress: { type: String, required: true },
    startTime: { type: Date, required: true, default: Date.now },
    endTime: Date,
    status: {
      type: String,
      enum: ['STARTED', 'IN_PROGRESS', 'SUBMITTED', 'ABANDONED', 'TIMEOUT', 'FORCE_SUBMITTED', 'UFM_MARKED'],
      default: 'STARTED',
    },
    timeSpent: { type: Number, default: 0 },
    totalQuestions: { type: Number, required: true },
    attemptedQuestions: { type: Number, default: 0 },
    submittedQuestions: { type: Number, default: 0 },
    isFrozen: { type: Boolean, default: false },
    freezeReason: { type: String, default: null },
    forceSubmitReason: { type: String, default: null },
    forcedByFaculty: { type: Boolean, default: false },
    ufmMarkedAt: Date,
    ufmReason: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

sessionSchema.index({ sessionId: 1 }, { unique: true });
sessionSchema.index({ examId: 1, studentId: 1 });
sessionSchema.index({ status: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

export const Session = model<ISession>('Session', sessionSchema);
