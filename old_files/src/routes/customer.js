import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Worker } from 'worker_threads';
import { CONFIG } from '../config.js';
import { db, getSetting, generateJobCode, updateJobStatus } from '../db.js';
import { queueEvents, getQueuePosition, processNext, notifyJobUpdate } from '../queue.js';
import { checkFreeDiskMB } from '../network.js';
import { logger } from '../logger.js';

// IP rate limiting map: ip -> array of timestamps
const ipUploads = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;
  let timestamps = ipUploads.get(ip) || [];
  timestamps = timestamps.filter((t) => t > windowStart);
  if (timestamps.length >= CONFIG.RATE_LIMIT_MAX_PER_IP) {
    ipUploads.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  ipUploads.set(ip, timestamps);
  return true;
}

function runFileWorker(filePaths, options = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(CONFIG.ROOT_DIR, 'src', 'fileProcessorWorker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        filePaths: Array.isArray(filePaths) ? filePaths : [filePaths],
        ...options
      }
    });

    worker.on('message', (result) => {
      resolve(result);
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

function calculatePrice(pages, copies, colorMode, duplexMode) {
  if (getSetting('enable_pricing', 'true') !== 'true') return 0;
  const bwRate = parseFloat(getSetting('price_bw_per_page', '2.00')) || 2.0;
  const colorRate = parseFloat(getSetting('price_color_per_page', '10.00')) || 10.0;
  const duplexDiscount = parseFloat(getSetting('price_duplex_discount', '0.50')) || 0.5;

  const baseRate = colorMode === 'color' ? colorRate : bwRate;
  let discountedPages = 0;
  if (duplexMode === 'duplexlong') {
    discountedPages = Math.floor(pages / 2);
  }
  const perCopy = (pages * baseRate) - (discountedPages * duplexDiscount);
  return Math.max(0, Math.round(perCopy * copies * 100) / 100);
}

export default async function customerRoutes(fastify, options) {
  // Public config for customer page (dynamic visibility and pricing)
  fastify.get('/api/config', async (req, reply) => {
    return {
      shopName: getSetting('shop_name', 'ShopPrint Station'),
      allowDuplex: getSetting('allow_duplex', 'true') === 'true',
      allowColor: getSetting('allow_color', 'true') === 'true',
      allow2on1: getSetting('allow_2on1', 'true') === 'true',
      allowOrientation: getSetting('allow_orientation', 'true') === 'true',
      allowCustomPages: getSetting('allow_custom_pages', 'true') === 'true',
      allowCopies: getSetting('allow_copies', 'true') === 'true',
      maxCopies: parseInt(getSetting('max_copies', '20'), 10) || 20,
      allowPaperSize: getSetting('allow_paper_size', 'false') === 'true',
      defaultPaperSize: getSetting('default_paper_size', 'A4'),
      defaultDuplex: getSetting('default_duplex', 'simplex'),
      defaultColor: getSetting('default_color', 'monochrome'),
      pricing: {
        enabled: getSetting('enable_pricing', 'true') === 'true',
        bwRate: parseFloat(getSetting('price_bw_per_page', '2.00')) || 2.0,
        colorRate: parseFloat(getSetting('price_color_per_page', '10.00')) || 10.0,
        duplexDiscount: parseFloat(getSetting('price_duplex_discount', '0.50')) || 0.5
      }
    };
  });

  // Upload endpoint (supports single or multiple files combined)
  fastify.post('/api/jobs/upload', async (req, reply) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    // 1. Rate limit check
    if (!checkRateLimit(clientIp)) {
      return reply.code(429).send({
        error: 'Too many uploads from your device. Please wait a few minutes.'
      });
    }

    // 2. Queue length check (max 40 waiting jobs)
    const waitingCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM jobs 
      WHERE status IN ('UPLOADED', 'PENDING_APPROVAL', 'QUEUED', 'PRINTING')
    `).get().cnt;

    if (waitingCount >= CONFIG.MAX_WAITING_JOBS) {
      return reply.code(429).send({
        error: 'Shop is busy, try later. The print queue is currently full.'
      });
    }

    // 3. Free disk space check (< 500 MB)
    const freeMB = checkFreeDiskMB();
    if (freeMB < CONFIG.MIN_FREE_DISK_MB) {
      logger.warn({ freeMB }, 'Insufficient disk space for upload');
      return reply.code(507).send({
        error: 'Printer station storage is full. Please inform the shopkeeper.'
      });
    }

    if (!fs.existsSync(CONFIG.UPLOADS_DIR)) {
      fs.mkdirSync(CONFIG.UPLOADS_DIR, { recursive: true });
    }

    // 4. Handle multipart stream for one or multiple files
    const uploadedFiles = [];
    const fields = {};
    let uploadAborted = false;

    req.raw.on('aborted', () => {
      uploadAborted = true;
      for (const f of uploadedFiles) {
        try { if (fs.existsSync(f.tempFilePath)) fs.unlinkSync(f.tempFilePath); } catch {}
      }
    });

    try {
      const parts = req.parts({
        limits: { fileSize: CONFIG.MAX_FILE_SIZE_BYTES }
      });

      for await (const part of parts) {
        if (part.type === 'file') {
          const tempFileName = `${crypto.randomUUID()}_${Date.now()}.tmp`;
          const tempFilePath = path.join(CONFIG.UPLOADS_DIR, tempFileName);
          const writeStream = fs.createWriteStream(tempFilePath);

          await pipeline(part.file, writeStream);

          const bytesWritten = fs.statSync(tempFilePath).size;
          uploadedFiles.push({
            tempFilePath,
            originalFilename: path.basename(part.filename || 'document'),
            bytesWritten
          });
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      for (const f of uploadedFiles) {
        try { if (fs.existsSync(f.tempFilePath)) fs.unlinkSync(f.tempFilePath); } catch {}
      }

      if (uploadAborted || err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          error: 'One or more files exceed the maximum size limit of 25 MB.'
        });
      }
      return reply.code(500).send({
        error: 'Upload interrupted or failed to save file. Please try again.'
      });
    }

    if (uploadedFiles.length === 0) {
      return reply.code(400).send({ error: 'No files provided for printing.' });
    }

    // Read form fields according to shopkeeper settings
    const allowCopies = getSetting('allow_copies', 'true') === 'true';
    const maxCopies = parseInt(getSetting('max_copies', '20'), 10) || 20;
    const copiesRaw = allowCopies ? (fields.copies || '1') : '1';
    const copies = Math.min(Math.max(parseInt(copiesRaw, 10) || 1, 1), maxCopies);

    const allowColor = getSetting('allow_color', 'true') === 'true';
    const colorMode = (allowColor && fields.color_mode === 'color') ? 'color' : 'monochrome';

    const allowDuplex = getSetting('allow_duplex', 'true') === 'true';
    const duplexMode = (allowDuplex && fields.duplex_mode === 'duplexlong') ? 'duplexlong' : 'simplex';

    const allow2on1 = getSetting('allow_2on1', 'true') === 'true';
    const pagesPerSheet = (allow2on1 && (fields.pages_per_sheet === '2' || fields.pages_per_sheet === 2)) ? 2 : 1;

    const allowOrientation = getSetting('allow_orientation', 'true') === 'true';
    const rawOrient = (fields.orientation || '').toLowerCase();
    const orientation = (allowOrientation && ['portrait', 'landscape'].includes(rawOrient)) ? rawOrient : 'auto';

    const allowCustomPages = getSetting('allow_custom_pages', 'true') === 'true';
    const pageRange = (allowCustomPages && fields.page_range && fields.page_range.trim()) ? fields.page_range.trim() : 'all';

    const customerName = (fields.customer_name || '').trim().slice(0, 50);

    // Format combined filename
    let originalFilename = uploadedFiles[0].originalFilename;
    if (uploadedFiles.length > 1) {
      originalFilename = `${uploadedFiles[0].originalFilename} + ${uploadedFiles.length - 1} more (${uploadedFiles.length} combined)`;
    }

    // Paper size & scaling options
    const allowedPaper = ['A4', 'A3', 'legal', 'letter'];
    const allowPaperSize = getSetting('allow_paper_size', 'false') === 'true';
    const reqPaper = (fields.paper_size || '').trim().toLowerCase();
    let paperSize = getSetting('default_paper_size', 'A4');
    if (allowPaperSize) {
      for (const p of allowedPaper) {
        if (p.toLowerCase() === reqPaper) {
          paperSize = p;
          break;
        }
      }
    }

    const fitMode = fields.fit_mode === 'noscale' ? 'noscale' : 'fit';
    const customerNote = (fields.customer_note || '').trim().slice(0, 200);

    // 5. Worker processing & magic byte validation / multi-file merging / 2-on-1
    let processResult;
    try {
      processResult = await runFileWorker(uploadedFiles.map(f => f.tempFilePath), {
        pagesPerSheet,
        pageRange,
        orientation
      });
    } catch (workerErr) {
      for (const f of uploadedFiles) {
        try { if (fs.existsSync(f.tempFilePath)) fs.unlinkSync(f.tempFilePath); } catch {}
      }
      return reply.code(500).send({
        error: 'Internal document processing error. Please try again.'
      });
    }

    if (!processResult || !processResult.success) {
      for (const f of uploadedFiles) {
        try { if (fs.existsSync(f.tempFilePath)) fs.unlinkSync(f.tempFilePath); } catch {}
      }
      return reply.code(400).send({
        error: processResult?.error || 'Invalid or unreadable document format.'
      });
    }

    const { processedPath, pageCount, fileType } = processResult;
    const totalBytes = uploadedFiles.reduce((sum, f) => sum + f.bytesWritten, 0);
    const estimatedPrice = calculatePrice(pageCount, copies, colorMode, duplexMode);

    // 6. Create Job in SQLite
    const token = crypto.randomUUID();
    const code = generateJobCode();
    const autoPrint = getSetting('auto_print', 'false') === 'true';
    const initialStatus = autoPrint ? 'QUEUED' : 'PENDING_APPROVAL';
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO jobs (
        code, token, client_ip, customer_name, original_filename,
        storage_path, file_type, file_size, page_count, copies,
        color_mode, duplex_mode, paper_size, fit_mode, customer_note,
        orientation, pages_per_sheet, page_range, estimated_price,
        status, retry_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    const result = stmt.run(
      code,
      token,
      clientIp,
      customerName,
      originalFilename,
      processedPath,
      fileType,
      totalBytes,
      pageCount,
      copies,
      colorMode,
      duplexMode,
      paperSize,
      fitMode,
      customerNote,
      orientation,
      pagesPerSheet,
      pageRange,
      estimatedPrice,
      initialStatus,
      now,
      now
    );

    const jobId = result.lastInsertRowid;
    updateJobStatus(jobId, initialStatus, 'Initial submission');
    notifyJobUpdate(jobId);

    queueEvents.emit('job_incoming', { jobId, code, customerName, paperSize, copies, note: customerNote, autoPrint });

    if (autoPrint) {
      processNext();
    } else {
      queueEvents.emit('job_needs_approval', { jobId, code, customerName, paperSize, copies, note: customerNote });
    }

    return reply.code(201).send({
      success: true,
      token,
      code,
      status: initialStatus,
      pageCount,
      copies,
      colorMode,
      duplexMode,
      paperSize,
      fitMode,
      customerNote,
      customerName,
      originalFilename,
      orientation,
      pagesPerSheet,
      pageRange,
      estimatedPrice
    });
  });

  // Get job details
  fastify.get('/api/jobs/:token', async (req, reply) => {
    const { token } = req.params;
    const job = db.prepare('SELECT * FROM jobs WHERE token = ?').get(token);

    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    const position = job.status === 'QUEUED' ? getQueuePosition(job.id) : null;

    return {
      code: job.code,
      status: job.status,
      customerName: job.customer_name,
      originalFilename: job.original_filename,
      pageCount: job.page_count,
      copies: job.copies,
      colorMode: job.color_mode,
      duplexMode: job.duplex_mode,
      paperSize: job.paper_size || 'A4',
      fitMode: job.fit_mode || 'fit',
      customerNote: job.customer_note || '',
      orientation: job.orientation || 'auto',
      pagesPerSheet: job.pages_per_sheet || 1,
      pageRange: job.page_range || 'all',
      estimatedPrice: job.estimated_price || 0,
      failureReason: job.failure_reason,
      position,
      createdAt: job.created_at
    };
  });

  // SSE endpoint for live updates
  fastify.get('/api/jobs/:token/sse', async (req, reply) => {
    const { token } = req.params;
    const job = db.prepare('SELECT * FROM jobs WHERE token = ?').get(token);

    if (!job) {
      return reply.code(404).send('Job not found');
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const sendUpdate = (currJob) => {
      const position = currJob.status === 'QUEUED' ? getQueuePosition(currJob.id) : null;
      const payload = {
        code: currJob.code,
        status: currJob.status,
        failureReason: currJob.failure_reason,
        position,
        pageCount: currJob.page_count,
        copies: currJob.copies,
        paperSize: currJob.paper_size || 'A4',
        fitMode: currJob.fit_mode || 'fit',
        customerNote: currJob.customer_note || '',
        updatedAt: currJob.updated_at
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Send immediate initial status
    sendUpdate(job);

    const onJobUpdated = (updatedJob) => {
      if (updatedJob.id === job.id) {
        sendUpdate(updatedJob);
      } else if (job.status === 'QUEUED') {
        // Queue position might have updated
        const fresh = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
        if (fresh) sendUpdate(fresh);
      }
    };

    queueEvents.on('job_updated', onJobUpdated);

    // Keepalive ping every 20 seconds
    const pingInterval = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 20000);

    req.raw.on('close', () => {
      clearInterval(pingInterval);
      queueEvents.off('job_updated', onJobUpdated);
    });
  });
}
