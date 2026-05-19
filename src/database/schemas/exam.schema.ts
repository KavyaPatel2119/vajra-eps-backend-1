import { Schema, model, Document } from 'mongoose';

export interface IExam extends Document {
  _id: string;
  examId: string;
  title: string;
  description: string;
  subject: string;
  courseCode: string;
  createdBy: string; // Faculty ID
  duration: number; // in minutes
  totalMarks: number;
  passingMarks: number;
  scheduledDate: Date;
  status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  registeredStudents: string[];
  questionCount: number;
  examRules?: string;
  createdAt: Date;
  updatedAt: Date;
}

const examSchema = new Schema<IExam>(
  {
    examId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: String,
    subject: { type: String, required: true },
    courseCode: { type: String, required: true },
    createdBy: { type: String, required: true },
    duration: { type: Number, required: true }, // minutes
    totalMarks: { type: Number, required: true },
    passingMarks: { type: Number, required: true },
    scheduledDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'ARCHIVED'],
      default: 'DRAFT',
    },
    registeredStudents: [String],
    questionCount: { type: Number, default: 0 },
    examRules: String,
  },
  { timestamps: true }
);

examSchema.index({ examId: 1 }, { unique: true });
examSchema.index({ status: 1, scheduledDate: 1 });
examSchema.index({ createdBy: 1 });
examSchema.index({ courseCode: 1 });

/** Strip nulls from registeredStudents so legacy DB rows cannot break .map / .toString(). */
examSchema.pre('save', function (next) {
  const doc = this as IExam & { registeredStudents?: unknown[] };
  if (Array.isArray(doc.registeredStudents)) {
    doc.registeredStudents = doc.registeredStudents.filter(
      (id: unknown) => id != null && id !== ''
    ) as string[];
  }
  next();
});

export const Exam = model<IExam>('Exam', examSchema);
