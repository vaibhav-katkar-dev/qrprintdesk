import fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { Db, MongoClient } from 'mongodb';
import { authRoutes } from './routes/authRoutes.js';
import { uploadRoutes } from './routes/uploadRoutes.js';
import { orderRoutes } from './routes/orderRoutes.js';
import { agentRoutes } from './routes/agentRoutes.js';
import { adminRoutes } from './routes/adminRoutes.js';
import { webhookRoutes } from './routes/webhookRoutes.js';
import { WebSocketHub } from './services/wsHub.js';
import { OutboxWorker } from './services/outboxWorker.js';
import { R2CleanupWorker } from './services/r2CleanupWorker.js';

export interface AppInstance {
  fastify: FastifyInstance;
  wsHub: WebSocketHub;
  outboxWorker: OutboxWorker;
  cleanupWorker: R2CleanupWorker;
  close: () => Promise<void>;
}

export function buildApp(db: Db, mongoClient: MongoClient, startWorkers: boolean = false): AppInstance {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'error',
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            remoteAddress: req.ip
          };
        }
      }
    }
  });

  // Preserve raw body for webhook signature verification while parsing JSON
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      const raw = body.toString('utf8');
      (req as any).rawBody = raw;
      const parsed = JSON.parse(raw);
      done(null, parsed);
    } catch (err: any) {
      done(err, undefined);
    }
  });

  // Register WebSocket plugin
  app.register(fastifyWebsocket);

  // Initialize WS Hub and Workers
  const wsHub = new WebSocketHub(db);
  const outboxWorker = new OutboxWorker(db, wsHub);
  const cleanupWorker = new R2CleanupWorker(db);

  // Health check endpoint
  app.get('/health', async () => {
    let mongoOk = false;
    try {
      await db.command({ ping: 1 });
      mongoOk = true;
    } catch (_) {}

    return {
      status: mongoOk ? 'healthy' : 'unhealthy',
      time: new Date().toISOString(),
      mongo: mongoOk ? 'connected' : 'disconnected'
    };
  });

  // Register WS handler
  app.register(async (instance) => {
    wsHub.register(instance);
  });

  // Register API route plugins
  app.register(authRoutes, { prefix: '/api', db });
  app.register(uploadRoutes, { prefix: '/api', db });
  app.register(orderRoutes, { prefix: '/api', db });
  app.register(agentRoutes, { prefix: '/api', db });
  app.register(adminRoutes, { prefix: '/api', db });
  app.register(webhookRoutes, { prefix: '/api', db, mongoClient });

  if (startWorkers) {
    outboxWorker.start();
    cleanupWorker.start();
  }

  const close = async () => {
    outboxWorker.stop();
    cleanupWorker.stop();
    wsHub.close();
    await app.close();
  };

  return {
    fastify: app,
    wsHub,
    outboxWorker,
    cleanupWorker,
    close
  };
}
