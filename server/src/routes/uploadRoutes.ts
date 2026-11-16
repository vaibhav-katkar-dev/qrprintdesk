import { FastifyPluginAsync } from 'fastify';
import { Db } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { generateFileKey, getPresignedUploadUrl, headR2Object, isLocalStorage, getLocalFilePath, s3Client } from '../services/r2.js';
import { ShopDocument } from '../types.js';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/jfif',
  'image/tiff',
  'image/heic',
  'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export const uploadRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // Direct file upload endpoint (Multipart form-data)
  fastify.post('/uploads/direct', async (request, reply) => {
    let filePart: any;
    try {
      filePart = await request.file();
    } catch (err: any) {
      return reply.code(400).send({ error: 'File upload error: ' + err.message });
    }

    if (!filePart) {
      return reply.code(400).send({ error: 'No file received in upload' });
    }

    const rawSlug = (filePart.fields?.shopSlug as any)?.value || (request.query as any)?.shopSlug || 'default';
    const shopSlug = String(rawSlug).replace(/^\/+|\/+$/g, '').split('?')[0].trim().toLowerCase() || 'default';
    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: `Shop "${shopSlug}" not found or inactive` });
    }

    const buffer = await filePart.toBuffer();
    const filename = filePart.filename || 'document.pdf';
    let mimeType = filePart.mimetype || 'application/pdf';
    const fileSize = buffer.length;

    // Detect MIME from extension if generic octet-stream
    const ext = (filename.split('.').pop() || 'pdf').toLowerCase();
    if (ext === 'pdf') mimeType = 'application/pdf';
    else if (ext === 'jpg' || ext === 'jpeg' || ext === 'jfif') mimeType = 'image/jpeg';
    else if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'bmp') mimeType = 'image/bmp';
    else if (ext === 'tiff' || ext === 'tif') mimeType = 'image/tiff';
    else if (ext === 'heic' || ext === 'heif') mimeType = 'image/heic';

    if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
      return reply.code(400).send({ error: `Unsupported file type: ${mimeType}` });
    }

    if (fileSize <= 0 || fileSize > MAX_FILE_SIZE_BYTES) {
      return reply.code(400).send({ error: 'File size exceeds 100MB limit' });
    }

    // Determine page count using high-speed heuristic first (<1ms), then fallback to pdf-lib
    let pageCount = 1;
    if (mimeType.toLowerCase() === 'application/pdf' || ext === 'pdf') {
      try {
        const previewStr = buffer.toString('latin1', 0, Math.min(buffer.length, 65536));
        const countMatch = previewStr.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
        if (countMatch && countMatch[1]) {
          pageCount = Math.max(1, parseInt(countMatch[1], 10));
        } else {
          const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
          pageCount = Math.max(1, pdfDoc.getPageCount());
        }
      } catch (err) {
        pageCount = 1;
      }
    }

    const fileKey = generateFileKey(shop._id.toString(), ext);

    // 1. Ultra-Fast Local Write (1ms): Save file immediately to local disk
    const localPath = getLocalFilePath(fileKey);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buffer);

    // 2. Non-blocking Asynchronous Cloud Sync:
    // If Backblaze B2 / R2 is configured, push to cloud in background without freezing the customer
    if (!isLocalStorage && s3Client) {
      const bucket = process.env.R2_BUCKET_NAME || 'printtestxyz';
      s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        Body: buffer,
        ContentType: mimeType
      })).catch((err: any) => {
        fastify.log.warn({ err: err.message, fileKey }, 'Background cloud storage sync notice');
      });
    }

    return reply.code(201).send({
      success: true,
      fileKey,
      originalFilename: filename,
      fileSize,
      mimeType,
      pageCount
    });
  });

  // Request a presigned PUT URL for R2 / direct storage
  fastify.post<{
    Body: {
      shopSlug: string;
      filename: string;
      mimeType: string;
      fileSize: number;
    };
  }>('/uploads/presigned-url', async (request, reply) => {
    const { shopSlug, filename, mimeType, fileSize } = request.body || {};

    if (!shopSlug || !filename || !mimeType || typeof fileSize !== 'number') {
      return reply.code(400).send({ error: 'Missing required upload parameters' });
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
      return reply.code(400).send({ error: `Unsupported MIME type: ${mimeType}` });
    }

    if (fileSize <= 0 || fileSize > MAX_FILE_SIZE_BYTES) {
      return reply.code(400).send({ error: 'File size exceeds 100MB limit or is invalid' });
    }

    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    const ext = filename.split('.').pop() || 'pdf';
    const key = generateFileKey(shop._id.toString(), ext);

    const { url } = await getPresignedUploadUrl(key, mimeType, 300);

    return reply.send({
      key,
      fileKey: key,
      uploadUrl: url,
      expiresIn: 300
    });
  });

  // Verify that an uploaded file exists
  fastify.post<{
    Body: {
      fileKey: string;
    };
  }>('/uploads/verify', async (request, reply) => {
    const { fileKey } = request.body || {};
    if (!fileKey) {
      return reply.code(400).send({ error: 'Missing fileKey' });
    }

    const check = await headR2Object(fileKey);
    return reply.send(check);
  });
};
