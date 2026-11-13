import fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { Db, MongoClient } from 'mongodb';
import { authRoutes } from './routes/authRoutes.js';
import { uploadRoutes } from './routes/uploadRoutes.js';
import { orderRoutes } from './routes/orderRoutes.js';
import { agentRoutes } from './routes/agentRoutes.js';
import { adminRoutes } from './routes/adminRoutes.js';
import { webhookRoutes } from './routes/webhookRoutes.js';
import { dashboardRoutes } from './routes/dashboardRoutes.js';
import { localStorageRoutes } from './routes/localStorageRoutes.js';
import { vendorRoutes } from './routes/vendorRoutes.js';
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
      let raw = body.toString('utf8');
      if (raw.charCodeAt(0) === 0xFEFF) {
        raw = raw.slice(1);
      }
      (req as any).rawBody = raw;
      if (!raw || raw.trim() === '') {
        return done(null, {});
      }
      const parsed = JSON.parse(raw);
      done(null, parsed);
    } catch (err: any) {
      done(err, undefined);
    }
  });

  // Register Multipart plugin for direct file uploads up to 100MB
  app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 5
    }
  });

  // Register Static plugin for customer PWA files
  const candidateDirs = [
    path.join(process.cwd(), 'server', 'public'),
    path.join(process.cwd(), 'public'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../public')
  ];
  let resolvedPublicDir = candidateDirs[0];
  for (const d of candidateDirs) {
    if (fs.existsSync(d)) {
      resolvedPublicDir = d;
      break;
    }
  }

  app.register(fastifyStatic, {
    root: resolvedPublicDir,
    prefix: '/public/',
    maxAge: 86400000, // 24hr cache for bandwidth & speed optimization
    etag: true
  });

  // Support /assets/* directly as well as /public/assets/*
  app.get('/assets/*', async (req, reply) => {
    const assetPath = req.url.replace(/^\/assets\//, '').split('?')[0];
    const fullPath = path.join(resolvedPublicDir, 'assets', assetPath);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(assetPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
      };
      if (mimeTypes[ext]) reply.type(mimeTypes[ext]);
      return reply.sendFile(path.join('assets', assetPath), resolvedPublicDir);
    }
    return reply.code(404).send({ error: 'Asset not found' });
  });

  // Indexes are managed centrally in db/mongo.ts ensureIndexes() — no duplicates here

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

  // Secured Admin Dashboard Route
  app.get('/admin', async (req, reply) => {
    return reply.sendFile('admin.html', resolvedPublicDir);
  });

  // Self-Service Vendor Portal Route (Bank details, auto-payouts, settlements)
  app.get('/vendor', async (req, reply) => {
    return reply.sendFile('vendor-portal.html', resolvedPublicDir);
  });

  // Customer PWA Routes (HTML never cached so customers always run latest frontend code)
  app.get('/shop/:shopSlug', async (req, reply) => {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return reply.sendFile('index.html', resolvedPublicDir);
  });

  app.get('/print', async (req, reply) => {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return reply.sendFile('index.html', resolvedPublicDir);
  });

  // Favicon Route
  app.get('/favicon.ico', async (req, reply) => {
    const icoPath = path.join(resolvedPublicDir, 'favicon.ico');
    if (fs.existsSync(icoPath)) {
      return reply.type('image/x-icon').sendFile('favicon.ico', resolvedPublicDir);
    }
    return reply.code(204).send();
  });

  // Website Landing Page Route
  app.get('/', async (req, reply) => {
    return reply.sendFile('landing.html', resolvedPublicDir);
  });

  // Register WS handler
  app.register(async (instance) => {
    wsHub.register(instance);
  });

  // Register API route plugins
  app.register(authRoutes, { prefix: '/api', db });
  app.register(uploadRoutes, { prefix: '/api', db });
  app.register(orderRoutes, { prefix: '/api', db, wsHub });
  app.register(agentRoutes, { prefix: '/api', db, wsHub });
  app.register(adminRoutes, { prefix: '/api', db });
  app.register(webhookRoutes, { prefix: '/api', db, mongoClient, wsHub });
  app.register(dashboardRoutes, { db, wsHub });
  app.register(localStorageRoutes, { prefix: '/api' });
  app.register(vendorRoutes, { prefix: '/api', db });

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
