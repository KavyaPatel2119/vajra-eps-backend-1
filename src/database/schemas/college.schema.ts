import { Schema, model, Document } from 'mongoose';

export interface ICollege extends Document {
  _id: string;
  collegeCode: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const collegeSchema = new Schema<ICollege>(
  {
    collegeCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, unique: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

collegeSchema.index({ collegeCode: 1 }, { unique: true });
collegeSchema.index({ name: 1 }, { unique: true });
collegeSchema.index({ isActive: 1 });

export const College = model<ICollege>('College', collegeSchema);
