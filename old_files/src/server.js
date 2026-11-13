import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import customerRoutes from './routes/customer.js';
import adminRoutes from './routes/admin.js';
import { initQueue } from './queue.js';
import { startCleanupSchedule } from './cleanup.js';
import { getLocalIP, startBonjourService, stopBonjourService } from './network.js';

export async function buildApp() {
  const fastify = Fastify({
    logger: false, // We use pino instance directly
    trustProxy: true
  });

  // Global Error Handler - never leak stack traces to customers
  fastify.setErrorHandler((error, request, reply) => {
    logger.error({ err: error.message, url: request.url }, 'Request error caught by global handler');
    const statusCode = error.statusCode || (error.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 500);
    const friendlyMessage = error.statusCode
      ? error.message
      : 'A processing error occurred. Please try again or ask the shopkeeper.';
    
    reply.code(statusCode).send({
      error: friendlyMessage
    });
  });

  // Cookies
  await fastify.register(fastifyCookie, {
    secret: 'shopprint-local-cookie-secret-key-1092',
    parseOptions: {}
  });

  // Multipart uploads (streamed directly to disk in route handlers)
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: CONFIG.MAX_FILE_SIZE_BYTES,
      files: 20
    }
  });

  // Serve static files (public folder)
  const publicDir = path.join(CONFIG.ROOT_DIR, 'public');
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/'
  });

  // Customer UI route
  fastify.get('/', async (req, reply) => {
    return reply.sendFile('index.html');
  });

  // Admin UI route
  fastify.get('/admin', async (req, reply) => {
    return reply.sendFile('admin.html');
  });

  // Register API routes
  await fastify.register(customerRoutes);
  await fastify.register(adminRoutes);

  return fastify;
}

export async function startServer() {
  const app = await buildApp();

  // Initialize queue (handles stuck jobs from restart)
  initQueue();

  // Start periodic 24h file cleanup
  startCleanupSchedule();

  const localIp = getLocalIP();

  try {
    await app.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    logger.info(`====================================================`);
    logger.info(` ShopPrint Server is RUNNING`);
    logger.info(` Customer Mobile URL: http://${localIp}:${CONFIG.PORT}`);
    logger.info(` Customer Local URL:  http://shopprint.local:${CONFIG.PORT}`);
    logger.info(` Shopkeeper Admin:    http://${localIp}:${CONFIG.PORT}/admin`);
    logger.info(` Mode:                ${CONFIG.PRINTER_MODE.toUpperCase()}`);
    logger.info(`====================================================`);

    // Broadcast mDNS bonjour service
    startBonjourService(CONFIG.PORT);
  } catch (err) {
    logger.error({ err }, 'Failed to start ShopPrint server');
    process.exit(1);
  }

  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down cleanly...`);
    stopBonjourService();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return app;
}

// Auto-start if invoked directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer();
}
