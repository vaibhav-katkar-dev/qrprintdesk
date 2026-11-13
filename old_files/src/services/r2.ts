import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

const r2Endpoint = process.env.R2_ENDPOINT || '';
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const r2BucketName = process.env.R2_BUCKET_NAME || 'shopprint-docs';

export const s3Client = new S3Client({
  region: 'auto',
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

export async function getPresignedUploadUrl(key: string, contentType: string, expiresInSeconds: number = 300): Promise<{ url: string; key: string }> {
  const command = new PutObjectCommand({
    Bucket: r2BucketName,
    Key: key,
    ContentType: contentType
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  // Note: Never log `url`
  return { url, key };
}

export async function getPresignedDownloadUrl(key: string, expiresInSeconds: number = 300): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: r2BucketName,
    Key: key
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

export async function headR2Object(key: string): Promise<{ exists: boolean; size?: number; contentType?: string; checksum?: string }> {
  try {
    const command = new HeadObjectCommand({
      Bucket: r2BucketName,
      Key: key
    });
    const response = await s3Client.send(command);
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
  try {
    const command = new DeleteObjectCommand({
      Bucket: r2BucketName,
      Key: key
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    return false;
  }
}
