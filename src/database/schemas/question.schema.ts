import { Schema, model, Document } from 'mongoose';

export interface IQuestion extends Document {
  _id: string;
  questionId: string;
  examId: any;
  type: 'MCQ' | 'MSQ' | 'SHORT_ANSWER' | 'ESSAY' | 'NUMERIC' | 'ONE_WORD' | 'IMAGE';
  questionText: string;
  marks: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  topic?: string;
  // options can be an array of strings (frontend) or objects with metadata
  options?: Array<string | { id?: string; text?: string; isCorrect?: boolean }>;
  correctAnswer?: string | string[];
  explanation?: string;
  imageUrl?: string;
  sequenceNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

const questionSchema = new Schema<IQuestion>(
  {
    questionId: { type: String, required: true, unique: true },
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', required: true },
    type: {
      type: String,
      enum: ['MCQ', 'MSQ', 'SHORT_ANSWER', 'ESSAY', 'NUMERIC', 'ONE_WORD', 'IMAGE'],
      required: true,
      set: (v: any) => {
        if (!v) return v;
        const s = String(v).trim().toUpperCase();
        if (s === 'ONEWORD' || s === 'ONE_WORD') return 'ONE_WORD';
        if (s === 'SHORT') return 'SHORT_ANSWER';
        if (s === 'SHORT_ANSWER') return 'SHORT_ANSWER';
        return s;
      },
    },
    questionText: { type: String, required: true },
    marks: { type: Number, required: true },
    difficulty: {
      type: String,
      enum: ['EASY', 'MEDIUM', 'HARD'],
      default: 'MEDIUM',
      set: (v: any) => {
        if (!v) return v;
        return String(v).trim().toUpperCase();
      },
    },
    topic: String,
    // allow flexible option types (string or object)
    options: { type: [Schema.Types.Mixed], default: [] },
    correctAnswer: Schema.Types.Mixed,
    explanation: String,
    sequenceNumber: { type: Number, required: true },
    imageUrl: { type: String },
  },
  { timestamps: true }
);

questionSchema.index({ questionId: 1 }, { unique: true });
questionSchema.index({ examId: 1, sequenceNumber: 1 });

export const Question = model<IQuestion>('Question', questionSchema);
