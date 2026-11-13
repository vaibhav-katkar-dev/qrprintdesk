import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { db } from './db.js';

export function runCleanup() {
  logger.info('Running file retention cleanup...');
  const cutoffTime = Date.now() - CONFIG.FILE_MAX_AGE_MS;
  let deletedFiles = 0;

  // 1. Clean up uploads directory
  if (fs.existsSync(CONFIG.UPLOADS_DIR)) {
    try {
      const files = fs.readdirSync(CONFIG.UPLOADS_DIR);
      for (const file of files) {
        const fullPath = path.join(CONFIG.UPLOADS_DIR, file);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs < cutoffTime) {
            fs.unlinkSync(fullPath);
            deletedFiles++;
          }
        } catch (err) {
          logger.warn({ err, file }, 'Error checking/unlinking expired upload file');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed reading uploads directory during cleanup');
    }
  }

  // 2. Clean up mock output directory if mock mode
  if (fs.existsSync(CONFIG.MOCK_OUTPUT_DIR)) {
    try {
      const mockFiles = fs.readdirSync(CONFIG.MOCK_OUTPUT_DIR);
      for (const file of mockFiles) {
        const fullPath = path.join(CONFIG.MOCK_OUTPUT_DIR, file);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs < cutoffTime) {
            fs.unlinkSync(fullPath);
            deletedFiles++;
          }
        } catch {}
      }
    } catch {}
  }

  logger.info({ deletedFiles }, 'File retention cleanup completed.');
}

export function startCleanupSchedule() {
  // Run once at startup
  runCleanup();
  // Hourly schedule
  return setInterval(runCleanup, CONFIG.CLEANUP_INTERVAL_MS);
}
