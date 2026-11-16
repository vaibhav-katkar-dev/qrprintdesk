import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const r2Endpoint = (process.env.R2_ENDPOINT || process.env.S3_ENDPOINT || process.env.B2_ENDPOINT || '').trim();
const r2AccessKeyId = (process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || process.env.B2_ACCESS_KEY_ID || '').trim();
const r2SecretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || process.env.B2_SECRET_ACCESS_KEY || '').trim();
const r2BucketName = (process.env.R2_BUCKET_NAME || process.env.S3_BUCKET_NAME || process.env.B2_BUCKET_NAME || 'QrPrintDesk-docs').trim();
const s3Region = (process.env.S3_REGION || process.env.R2_REGION || (r2Endpoint.includes('backblazeb2.com') ? 'us-east-005' : 'auto')).trim();

export const isLocalStorage = !r2Endpoint || process.env.STORAGE_MODE === 'local';

// Local storage directory on device for offline/local testing
export const LOCAL_STORAGE_DIR = path.join(process.cwd(), 'data', 'storage');
if (isLocalStorage && !fs.existsSync(LOCAL_STORAGE_DIR)) {
  fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

export const s3Client = isLocalStorage
  ? null
  : new S3Client({
      region: s3Region,
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey
      }
    });

export function generateFileKey(shopId: string, extension: string = 'pdf'): string {
  const random = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  return `shops/${shopId}/${timestamp}-${random}.${extension.replace(/^\./, '')}`;
}

export function getLocalFilePath(key: string): string {
  // Normalize key to prevent path traversal
  const safeKey = key.replace(/\.\./g, '').replace(/^[/\\]+/, '');
  return path.join(LOCAL_STORAGE_DIR, safeKey);
}

// Generate a temporary signing token for local uploads/downloads
function signLocalKey(key: string): string {
  const secret = process.env.LOCAL_STORAGE_SECRET || 'local-QrPrintDesk-dev-secret';
  return crypto.createHmac('sha256', secret).update(key).digest('hex').slice(0, 16);
}

export function verifyLocalToken(key: string, token: string): boolean {
  return signLocalKey(key) === token;
}

export async function getPresignedUploadUrl(
  key: string,
  contentType?: string,
  expiresInSeconds: number = 300
): Promise<{ url: string; key: string }> {
  if (isLocalStorage) {
    const serverBaseUrl = (process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const token = signLocalKey(key);
    const url = `${serverBaseUrl}/api/storage/upload?key=${encodeURIComponent(key)}&token=${token}`;
    return { url, key };
  }

  // Omitting strict ContentType signing allows client browsers to upload flexibly without 403 SignatureMismatch
  const command = new PutObjectCommand({
    Bucket: r2BucketName,
    Key: key
  });

  const url = await getSignedUrl(s3Client!, command, { expiresIn: expiresInSeconds });
  return { url, key };
}

export async function getPresignedDownloadUrl(key: string, expiresInSeconds: number = 300): Promise<string> {
  const localFilePath = getLocalFilePath(key);
  const serverBaseUrl = (process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

  // High-Speed Local Cache: If file is stored on local server, serve directly (0.01s latency)
  if (isLocalStorage || fs.existsSync(localFilePath)) {
    const token = signLocalKey(key);
    return `${serverBaseUrl}/api/storage/download/${key}?token=${token}`;
  }

  const command = new GetObjectCommand({
    Bucket: r2BucketName,
    Key: key
  });

  return getSignedUrl(s3Client!, command, { expiresIn: expiresInSeconds });
}

export async function headR2Object(key: string): Promise<{ exists: boolean; size?: number; contentType?: string; checksum?: string }> {
  // Check local disk first (sub-millisecond instant response)
  const filePath = getLocalFilePath(key);
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      return {
        exists: true,
        size: stats.size,
        contentType: 'application/pdf',
        checksum: `local_${stats.mtimeMs}`
      };
    }
  } catch (_) {}

  if (isLocalStorage || !s3Client) {
    return { exists: false };
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: r2BucketName,
      Key: key
    });
    const response = await s3Client!.send(command);
    return {
      exists: true,
      size: response.ContentLength,
      contentType: response.ContentType,
      checksum: response.ETag?.replace(/"/g, '')
    };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw err;
  }
}

export async function deleteR2Object(key: string): Promise<boolean> {
  if (isLocalStorage) {
    const filePath = getLocalFilePath(key);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: r2BucketName,
      Key: key
    });
    await s3Client!.send(command);
    return true;
  } catch (err) {
    return false;
  }
}
