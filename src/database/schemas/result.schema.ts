import { Schema, model, Document } from 'mongoose';

export interface IResult extends Document {
  _id: string;
  resultId: string;
  examId: string;
  studentId: string;
  sessionId: string;
  totalMarks: number;
  obtainedMarks: number;
  percentage: number;
  grade: string;
  status: 'PASS' | 'FAIL' | 'PENDING_REVIEW';
  topicWiseAnalysis?: {
    topic: string;
    marksObtained: number;
    totalMarks: number;
    percentage: number;
  }[];
  resultPublishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const resultSchema = new Schema<IResult>(
  {
    resultId: { type: String, required: true, unique: true },
    examId: { type: String, required: true },
    studentId: { type: String, required: true },
    sessionId: { type: String, required: true },
    totalMarks: { type: Number, required: true },
    obtainedMarks: { type: Number, required: true },
    percentage: { type: Number, required: true },
    grade: { type: String, required: true },
    status: {
      type: String,
      enum: ['PASS', 'FAIL', 'PENDING_REVIEW'],
      default: 'PENDING_REVIEW',
    },
    topicWiseAnalysis: [
      {
        topic: String,
        marksObtained: Number,
        totalMarks: Number,
        percentage: Number,
      },
    ],
    resultPublishedAt: Date,
  },
  { timestamps: true }
);

resultSchema.index({ resultId: 1 }, { unique: true });
resultSchema.index({ examId: 1, studentId: 1 });
resultSchema.index({ status: 1 });

export const Result = model<IResult>('Result', resultSchema);
