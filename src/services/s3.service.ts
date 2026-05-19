import AWS from 'aws-sdk';
import { Readable } from 'stream';
import logger from '../config/logger';

/**
 * AWS S3 Service Layer
 * Handles all S3 operations for VAJRA EPS
 */

export class S3Service {
  private s3: AWS.S3;
  private bucketName: string;
  private region: string;

  constructor() {
    // Initialize AWS S3
    this.bucketName = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || '';
    this.region = process.env.AWS_REGION || 'us-east-1';

    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: this.region,
    });

    logger.info('✅ S3 Service initialized');
  }

  /**
   * Upload file to S3
   */
  async uploadFile(
    fileStream: Readable,
    key: string,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<{ url: string; key: string; bucket: string }> {
    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        Metadata: metadata || {},
      };

      const result = await this.s3.upload(params).promise();

      const publicUrl = this.getPublicUrl(key);

      logger.info(`✅ File uploaded to S3: ${key}`);

      return {
        url: publicUrl,
        key: result.Key,
        bucket: result.Bucket,
      };
    } catch (error) {
      logger.error('❌ S3 upload failed:', error);
      throw error;
    }
  }

  /**
   * Upload UFM evidence video
   */
  async uploadUFMEvidence(
    fileStream: Readable,
    ufmCaseId: string,
    filename: string,
    contentType = 'video/webm',
    context?: { examId?: string; examName?: string; studentName?: string; studentId?: string }
  ): Promise<{ url: string; key: string }> {
    const examPart = this.safePathSegment(context?.examId || ufmCaseId);
    const studentPart = this.safePathSegment(context?.studentId || context?.studentName || 'student');
    const casePart = this.safePathSegment(ufmCaseId);
    const extension = this.resolveExtension(filename, contentType, '.webm');
    const key = `video/exam/${examPart}/student/${studentPart}/${casePart}${extension}`;

    return this.uploadFile(fileStream, key, contentType,
    {
      'case-id': ufmCaseId,
      'upload-type': 'ufm-evidence',
    });
  }

  /**
   * Upload UFM report PDF
   */
  async uploadUFMReport(
    fileStream: Readable,
    ufmCaseId: string,
    context?: { examId?: string; examName?: string; studentName?: string; studentId?: string }
  ): Promise<{ url: string; key: string }> {
    const examPart = this.safePathSegment(context?.examId || ufmCaseId);
    const studentPart = this.safePathSegment(context?.studentName || context?.studentId || 'student');
    const casePart = this.safePathSegment(ufmCaseId);
    const key = `report/exam/${examPart}/student/${studentPart}/${casePart}.pdf`;

    return this.uploadFile(fileStream, key, 'application/pdf', {
      'case-id': ufmCaseId,
      'upload-type': 'ufm-report',
    });
  }

  /**
   * Upload study material
   */
  async uploadStudyMaterial(
    fileStream: Readable,
    examId: string,
    filename: string,
    contentType: string,
    context?: { examName?: string }
  ): Promise<{ url: string; key: string }> {
    const examPart = this.safePathSegment(examId);
    const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
    const materialName = contentType === 'application/pdf' || extension
      ? `material${extension || '.pdf'}`
      : this.safePathSegment(filename);
    const key = `material/exam/${examPart}/${materialName}`;

    return this.uploadFile(fileStream, key, contentType, {
      'exam-id': examId,
      'upload-type': 'study-material',
    });
  }

  /**
   * Upload screenshot
   */
  async uploadScreenshot(
    fileStream: Readable,
    sessionId: string,
    timestamp: number
  ): Promise<{ url: string; key: string }> {
    const key = `screenshots/${sessionId}/${timestamp}.jpg`;

    return this.uploadFile(fileStream, key, 'image/jpeg', {
      'session-id': sessionId,
      'upload-type': 'screenshot',
    });
  }

  /**
   * Delete file from S3
   */
  async deleteFile(key: string): Promise<boolean> {
    try {
      await this.s3
        .deleteObject({
          Bucket: this.bucketName,
          Key: key,
        })
        .promise();

      logger.info(`✅ File deleted from S3: ${key}`);
      return true;
    } catch (error) {
      logger.error('❌ S3 delete failed:', error);
      return false;
    }
  }

  /**
   * Get file from S3
   */
  async getFile(key: string): Promise<Readable> {
    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
      };

      return this.s3.getObject(params).createReadStream();
    } catch (error) {
      logger.error('❌ S3 get file failed:', error);
      throw error;
    }
  }

  /**
   * List files in a prefix
   */
  async listFiles(prefix: string, maxKeys: number = 100) {
    try {
      const params = {
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
      };

      const result = await this.s3.listObjectsV2(params).promise();

      return {
        files: result.Contents || [],
        isTruncated: result.IsTruncated,
        nextContinuationToken: result.NextContinuationToken,
      };
    } catch (error) {
      logger.error('❌ S3 list files failed:', error);
      throw error;
    }
  }

  /**
   * Get public URL for a file
   */
  getPublicUrl(key: string): string {
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
  }

  safePathSegment(value: string): string {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.\-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized || 'unknown';
  }

  private resolveExtension(filename: string, contentType: string, fallback: string): string {
    const cleanName = String(filename || '').split(/[\\/]/).pop() || '';
    const dotIndex = cleanName.lastIndexOf('.');
    if (dotIndex >= 0 && dotIndex < cleanName.length - 1) {
      const extension = cleanName.slice(dotIndex).toLowerCase().replace(/[^a-z0-9.]+/g, '');
      if (extension && extension !== '.') return extension;
    }

    const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
    const extensionByType: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/mpeg': '.mpeg',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'video/x-matroska': '.mkv',
      'video/webm': '.webm',
      'application/octet-stream': '.mp4',
    };

    return extensionByType[normalizedType] || fallback;
  }

  /**
   * Generate presigned URL for private files
   */
  getPresignedUrl(key: string, expiresIn: number = 3600): string {
    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Expires: expiresIn,
      };

      return this.s3.getSignedUrl('getObject', params);
    } catch (error) {
      logger.error('❌ Failed to generate presigned URL:', error);
      throw error;
    }
  }

  /**
   * Generate a presigned URL from a stored S3 URL or key.
   * Stored URLs are private bucket URLs, so the UI must use signed URLs to open proof media.
   */
  getPresignedUrlFromUrl(fileUrlOrKey: string, expiresIn: number = 3600): string {
    const key = this.extractKeyFromUrl(fileUrlOrKey);
    if (!key) {
      throw new Error('Unable to resolve S3 object key');
    }
    return this.getPresignedUrl(key, expiresIn);
  }

  getKeyFromUrl(fileUrlOrKey: string): string | null {
    return this.extractKeyFromUrl(fileUrlOrKey);
  }

  async fileExistsFromUrl(fileUrlOrKey: string): Promise<boolean> {
    const key = this.extractKeyFromUrl(fileUrlOrKey);
    return key ? this.fileExists(key) : false;
  }

  private extractKeyFromUrl(fileUrlOrKey: string): string | null {
    const value = String(fileUrlOrKey || '').trim();
    if (!value) return null;

    if (!/^https?:\/\//i.test(value)) {
      return value.replace(/^\/+/, '');
    }

    try {
      const parsed = new URL(value);
      const pathKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      if (parsed.hostname.startsWith(`${this.bucketName}.s3.`)) return pathKey;
      if (parsed.hostname === 's3.amazonaws.com' || parsed.hostname.startsWith('s3.')) {
        const prefix = `${this.bucketName}/`;
        return pathKey.startsWith(prefix) ? pathKey.slice(prefix.length) : pathKey;
      }
      return pathKey;
    } catch {
      return null;
    }
  }

  /**
   * Check if file exists
   */
  async fileExists(key: string): Promise<boolean> {
    try {
      await this.s3
        .headObject({
          Bucket: this.bucketName,
          Key: key,
        })
        .promise();

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Copy file within S3
   */
  async copyFile(sourceKey: string, destinationKey: string): Promise<boolean> {
    try {
      await this.s3
        .copyObject({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${sourceKey}`,
          Key: destinationKey,
        })
        .promise();

      logger.info(`✅ File copied in S3: ${sourceKey} -> ${destinationKey}`);
      return true;
    } catch (error) {
      logger.error('❌ S3 copy failed:', error);
      return false;
    }
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(key: string) {
    try {
      const result = await this.s3
        .headObject({
          Bucket: this.bucketName,
          Key: key,
        })
        .promise();

      return {
        size: result.ContentLength,
        contentType: result.ContentType,
        lastModified: result.LastModified,
        etag: result.ETag,
        metadata: result.Metadata,
      };
    } catch (error) {
      logger.error('❌ Failed to get file metadata:', error);
      throw error;
    }
  }

  /**
   * Get S3 service health
   */
  async getHealth(): Promise<boolean> {
    try {
      await this.s3.headBucket({ Bucket: this.bucketName }).promise();
      return true;
    } catch (error) {
      logger.error('❌ S3 health check failed:', error);
      return false;
    }
  }
}

export const s3Service = new S3Service();
