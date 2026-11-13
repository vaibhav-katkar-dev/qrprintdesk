import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const isRunningTests = process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test'));

export const CONFIG = {
  ROOT_DIR,
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: '0.0.0.0',
  PRINTER_MODE: process.env.PRINTER_MODE || (isRunningTests ? 'mock' : 'real'), // 'mock' or 'real'
  SUMATRA_PATH: process.env.SUMATRA_PATH || path.join(ROOT_DIR, 'bin', 'SumatraPDF.exe'),
  DATA_DIR: path.join(ROOT_DIR, 'data'),
  UPLOADS_DIR: path.join(ROOT_DIR, 'data', 'uploads'),
  MOCK_OUTPUT_DIR: path.join(ROOT_DIR, 'mock-output'),
  DB_PATH: path.join(ROOT_DIR, 'data', 'shopprint.db'),
  LOG_PATH: path.join(ROOT_DIR, 'data', 'shopprint.log'),

  MAX_FILE_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_WAITING_JOBS: 40,
  MIN_FREE_DISK_MB: 500,

  RATE_LIMIT_WINDOW_MS: 10 * 60 * 1000, // 10 minutes
  RATE_LIMIT_MAX_PER_IP: 10,

  FILE_MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000,  // hourly
  PRINTER_RETRY_BACKOFF_MS: [3000, 6000] // auto retry delays
};
