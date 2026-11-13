import { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getLocalFilePath, verifyLocalToken } from '../services/r2.js';

export const localStorageRoutes: FastifyPluginAsync = async (fastify) => {
  // Allow all binary content types for PUT upload endpoint
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  // Local storage PUT upload endpoint (receives raw file stream from customer browser)
  fastify.put('/storage/upload', async (request, reply) => {
    const key = (request.query as any).key as string;
    const token = (request.query as any).token as string;

    if (!key) {
      return reply.code(400).send({ error: 'Missing key parameter' });
    }

    if (token && !verifyLocalToken(key, token)) {
      return reply.code(403).send({ error: 'Invalid or expired upload token' });
    }

    const targetPath = getLocalFilePath(key);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    try {
      const buffer = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from((request.body as any) || '');
      await fs.promises.writeFile(targetPath, buffer);
      const stat = fs.statSync(targetPath);

      return reply.code(200).send({
        success: true,
        key,
        size: stat.size,
        message: 'File stored successfully on local test device'
      });
    } catch (err: any) {
      return reply.code(500).send({ error: `Upload write failed: ${err.message}` });
    }
  });

  // Local storage GET download endpoint (serves file stream to Windows Agent or browser)
  fastify.get('/storage/download/*', async (request, reply) => {
    const key = (request.params as any)['*'] as string;
    if (!key) {
      return reply.code(400).send({ error: 'Missing file key' });
    }

    const targetPath = getLocalFilePath(key);
    if (!fs.existsSync(targetPath)) {
      return reply.code(404).send({ error: 'File not found in local storage' });
    }

    const stat = fs.statSync(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    let mimeType = 'application/octet-stream';
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.jpg' || ext === '.jpeg' || ext === '.jfif') mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.bmp') mimeType = 'image/bmp';
    else if (ext === '.tiff' || ext === '.tif') mimeType = 'image/tiff';
    else if (ext === '.heic' || ext === '.heif') mimeType = 'image/heic';

    reply.header('Content-Type', mimeType);
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `inline; filename="${path.basename(targetPath)}"`);

    return reply.send(fs.createReadStream(targetPath));
  });
};
