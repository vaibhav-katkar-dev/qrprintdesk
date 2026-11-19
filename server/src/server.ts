import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config(); // fallback

import { initMongo } from './db/mongo.js';
import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'QrPrintDesk';

async function startServer() {
  try {
    const { client, db } = await initMongo(MONGO_URI, DB_NAME);
    const app = buildApp(db, client, true);

    await app.fastify.listen({ port: PORT, host: HOST });
    app.fastify.log.info({ port: PORT, host: HOST }, 'QrPrintDesk Cloud Control Plane running');

    const shutdown = async (signal: string) => {
      app.fastify.log.info({ signal }, 'Graceful shutdown initiated');
      try {
        await app.close();
        await client.close();
        app.fastify.log.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason, p) => {
      app.fastify.log.error({ reason, promise: p }, 'Unhandled Rejection');
    });
    process.on('uncaughtException', (err) => {
      app.fastify.log.error({ err }, 'Uncaught Exception');
    });
  } catch (err: any) {
    console.error('Fatal startup error:', err?.message || err);
    process.exit(1);
  }
}

startServer();
