import EventEmitter from 'events';
import fs from 'fs';
import { db, getSetting, setSetting, updateJobStatus } from './db.js';
import { printJob } from './printer.js';
import { logger } from './logger.js';
import { CONFIG } from './config.js';

export const queueEvents = new EventEmitter();
queueEvents.setMaxListeners(100);

let isProcessing = false;

export function initQueue() {
  // Crash recovery:
  // On startup, jobs stuck in PRINTING go to a "check before reprint" state
  const stuckJobs = db.prepare("SELECT id FROM jobs WHERE status = 'PRINTING'").all();
  for (const row of stuckJobs) {
    updateJobStatus(
      row.id,
      'CHECK_REPRINT',
      'Server restarted while job was in progress. Please check tray before reprinting.'
    );
  }

  // Leftover queued jobs from previous session should NOT auto-print on startup
  const leftoverQueued = db.prepare("SELECT id FROM jobs WHERE status = 'QUEUED'").all();
  for (const row of leftoverQueued) {
    updateJobStatus(
      row.id,
      'PENDING_APPROVAL',
      'Server restarted. Shopkeeper approval required before printing.'
    );
  }

  logger.info({ stuckRecovered: stuckJobs.length, queuedHeld: leftoverQueued.length }, 'Queue initialized.');
}

export function notifyJobUpdate(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (job) {
    queueEvents.emit('job_updated', job);
  }
}

export function getQueuePosition(jobId) {
  const job = db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'QUEUED') return 0;

  // Position is 1 (current printing) + count of QUEUED with lower id
  const countBefore = db.prepare(`
    SELECT COUNT(*) as cnt FROM jobs 
    WHERE status = 'QUEUED' AND id < ?
  `).get(job.id);

  const currentlyPrinting = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'PRINTING'").get();
  return (currentlyPrinting.cnt || 0) + (countBefore.cnt || 0) + 1;
}

export async function processNext() {
  if (isProcessing) return;

  const isPaused = getSetting('queue_paused', 'false') === 'true';
  if (isPaused) {
    logger.debug('Print queue is paused. Skipping execution.');
    return;
  }

  const nextJob = db.prepare(`
    SELECT * FROM jobs 
    WHERE status = 'QUEUED' 
    ORDER BY id ASC 
    LIMIT 1
  `).get();

  if (!nextJob) {
    return;
  }

  isProcessing = true;
  const jobId = nextJob.id;
  const printerName = getSetting('selected_printer', '');

  // Strict file validation before spooling
  if (!nextJob.storage_path || !fs.existsSync(nextJob.storage_path)) {
    updateJobStatus(jobId, 'FAILED', 'Document file missing from server. Cancelled to prevent blank page print.');
    notifyJobUpdate(jobId);
    isProcessing = false;
    setImmediate(processNext);
    return;
  }

  const fileStats = fs.statSync(nextJob.storage_path);
  if (fileStats.size < 64) {
    updateJobStatus(jobId, 'FAILED', 'Document file is empty (0 bytes). Cancelled to prevent blank page print.');
    notifyJobUpdate(jobId);
    isProcessing = false;
    setImmediate(processNext);
    return;
  }

  updateJobStatus(jobId, 'PRINTING');
  notifyJobUpdate(jobId);

  try {
    await printJob(nextJob, printerName);

    // Job succeeded
    updateJobStatus(jobId, 'DONE');
    notifyJobUpdate(jobId);

    // Privacy mode: delete immediately after printing
    const privacyMode = getSetting('privacy_mode', 'false') === 'true';
    if (privacyMode && nextJob.storage_path && fs.existsSync(nextJob.storage_path)) {
      try {
        fs.unlinkSync(nextJob.storage_path);
        logger.info({ jobId }, 'Privacy mode active: job file securely removed after printing.');
      } catch (err) {
        logger.warn({ err }, 'Failed to delete file in privacy mode');
      }
    }
  } catch (err) {
    logger.error({ err: err.message, jobId }, 'Job printing encountered an error');

    // Auto-retry up to 2 times
    const currentRetries = nextJob.retry_count || 0;
    if (currentRetries < 2) {
      const nextRetry = currentRetries + 1;
      const delay = CONFIG.PRINTER_RETRY_BACKOFF_MS[currentRetries] || 3000;

      logger.warn({ jobId, nextRetry, delay }, `Auto-retrying print job in ${delay}ms`);

      db.prepare('UPDATE jobs SET retry_count = ? WHERE id = ?').run(nextRetry, jobId);
      updateJobStatus(jobId, 'QUEUED', `Retrying (${nextRetry}/2): ${err.message}`);
      notifyJobUpdate(jobId);

      await new Promise((r) => setTimeout(r, delay));
    } else {
      // Pause queue, mark job FAILED, show alert
      setSetting('queue_paused', 'true');
      updateJobStatus(
        jobId,
        'FAILED',
        `Printer error: ${err.message}. Queue paused. Check printer and click Retry.`
      );
      notifyJobUpdate(jobId);
      queueEvents.emit('printer_alert', {
        jobId,
        error: err.message,
        printer: printerName
      });
    }
  } finally {
    isProcessing = false;
    // Process next item in FIFO queue
    setImmediate(processNext);
  }
}
