import { College } from '../../database/schemas/college.schema';

export class CollegeService {
  async getAllColleges() {
    return College.find({ isActive: true }).sort({ name: 1 });
  }
}

export const collegeService = new CollegeService();
