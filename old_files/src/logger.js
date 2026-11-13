import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

if (!fs.existsSync(CONFIG.DATA_DIR)) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// Log to both file and console
const transport = pino.transport({
  targets: [
    {
      target: 'pino/file',
      options: { destination: CONFIG.LOG_PATH, mkdir: true },
      level: 'info'
    },
    {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
      level: 'info'
    }
  ]
});

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime
}, transport);
