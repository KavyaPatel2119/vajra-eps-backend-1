import { Schema, model, Document } from 'mongoose';

export interface IAnswer extends Document {
  _id: string;
  answerId: string;
  sessionId: string;
  questionId: string;
  studentId: string;
  answer: string | string[];
  answerText?: string;
  markedForReview: boolean;
  submittedAt?: Date;
  marks?: number;
  isCorrect?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const answerSchema = new Schema<IAnswer>(
  {
    answerId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    questionId: { type: String, required: true },
    studentId: { type: String, required: true },
    answer: Schema.Types.Mixed,
    answerText: String,
    markedForReview: { type: Boolean, default: false },
    submittedAt: Date,
    marks: Number,
    isCorrect: Boolean,
  },
  { timestamps: true }
);

answerSchema.index({ answerId: 1 }, { unique: true });
answerSchema.index({ sessionId: 1, questionId: 1 });
answerSchema.index({ studentId: 1 });

export const Answer = model<IAnswer>('Answer', answerSchema);
