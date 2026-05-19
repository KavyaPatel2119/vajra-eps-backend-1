import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import logger from '../config/logger';

const uploadRoot = process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), 'vajra-eps-uploads');

function safeFileName(originalName: string) {
  const extension = path.extname(originalName || '').slice(0, 24);
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;
}

export function createDiskUpload(limitBytes: number) {
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await fsp.mkdir(uploadRoot, { recursive: true });
          cb(null, uploadRoot);
        } catch (error) {
          cb(error as Error, uploadRoot);
        }
      },
      filename: (_req, file, cb) => cb(null, safeFileName(file.originalname)),
    }),
    limits: { fileSize: limitBytes },
  });
}

export function openUploadedFileStream(file: Express.Multer.File) {
  if (!file.path) {
    throw new Error('Uploaded file was not written to disk');
  }
  return fs.createReadStream(file.path);
}

export async function readUploadedFileBuffer(file: Express.Multer.File) {
  if (!file.path) {
    throw new Error('Uploaded file was not written to disk');
  }
  return fsp.readFile(file.path);
}

export async function cleanupUploadedFile(file?: Express.Multer.File | null) {
  if (!file?.path) return;
  try {
    await fsp.unlink(file.path);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`Failed to delete temp upload ${file.path}`, error);
    }
  }
}
