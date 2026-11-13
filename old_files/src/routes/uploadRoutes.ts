import { FastifyPluginAsync } from 'fastify';
import { Db } from 'mongodb';
import { generateFileKey, getPresignedUploadUrl, headR2Object } from '../services/r2.js';
import { ShopDocument } from '../types.js';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export const uploadRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // Request a presigned PUT URL for R2
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

    // Lookup shop
    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    // Server-generated random key
    const ext = filename.split('.').pop() || 'pdf';
    const key = generateFileKey(shop._id.toString(), ext);

    const { url } = await getPresignedUploadUrl(key, mimeType, 300);

    return reply.send({
      key,
      uploadUrl: url,
      expiresIn: 300
    });
  });

  // Verify that an uploaded file exists in R2
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
