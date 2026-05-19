import mongoose from 'mongoose';
import logger from './logger';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/vajra-eps';

export async function connectDatabase() {
  try {
    await mongoose.connect(MONGODB_URI);
    logger.info('✅ MongoDB connected successfully');
    return mongoose.connection;
  } catch (error) {
    logger.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

export async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    logger.info('✅ MongoDB disconnected');
  } catch (error) {
    logger.error('❌ MongoDB disconnection failed:', error);
  }
}

export default mongoose.connection;
