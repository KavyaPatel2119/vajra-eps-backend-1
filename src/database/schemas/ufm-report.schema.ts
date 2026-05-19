import { Schema, model, Document } from 'mongoose';

export interface IUFMReport extends Document {
  _id: string;
  ufmId: string;
  studentId: string;
  examId: string;
  sessionId?: string;
  reason: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  evidence: Array<
    | string
    | {
        type: string;
        description: string;
        data: Record<string, any>;
        timestamp: Date;
      }
  >;
  isImmutable: boolean;
  status: 'OPEN' | 'UNDER_REVIEW' | 'FORWARDED_TO_COMMITTEE' | 'RESOLVED' | 'CLOSED' | 'APPEALED' | 'DISMISSED';
  pdfReportUrl?: string;
  evidenceVideoUrl?: string;
  appealReason?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  remarks?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ufmReportSchema = new Schema<IUFMReport>(
  {
    ufmId: { type: String, required: true, unique: true },
    studentId: { type: String, required: true },
    examId: { type: String, required: true },
    sessionId: String,
    reason: [String],
    severity: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      required: true,
    },
    evidence: { type: [Schema.Types.Mixed], default: [] },
    isImmutable: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['OPEN', 'UNDER_REVIEW', 'FORWARDED_TO_COMMITTEE', 'RESOLVED', 'CLOSED', 'APPEALED', 'DISMISSED'],
      default: 'OPEN',
    },
    pdfReportUrl: String,
    evidenceVideoUrl: String,
    appealReason: String,
    reviewedBy: String,
    reviewedAt: Date,
    remarks: String,
  },
  { timestamps: true }
);

// Make immutable after creation
ufmReportSchema.pre('save', function (next) {
  if (this.isModified() && !this.isNew) {
    throw new Error('UFM reports are immutable');
  }
  next();
});

ufmReportSchema.index({ ufmId: 1 }, { unique: true });
ufmReportSchema.index({ studentId: 1, status: 1 });
ufmReportSchema.index({ examId: 1 });
ufmReportSchema.index({ createdAt: -1 });

export const UFMReport = model<IUFMReport>('UFMReport', ufmReportSchema);
