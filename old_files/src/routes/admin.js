import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { db, getSetting, setSetting, hashPin, verifyPin, updateJobStatus, createAdminSession, verifyAdminSession, removeAdminSession } from '../db.js';
import { getLocalIP, getPrinters, checkFreeDiskMB } from '../network.js';
import { queueEvents, processNext, notifyJobUpdate } from '../queue.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';

function generateSessionToken() {
  const token = crypto.randomBytes(32).toString('hex');
  createAdminSession(token);
  return token;
}

function verifySession(token) {
  return verifyAdminSession(token);
}

export default async function adminRoutes(fastify, options) {
  // Auth status check
  fastify.get('/api/admin/auth-status', async (req, reply) => {
    const pinHash = getSetting('admin_pin_hash', '');
    const isPinSet = Boolean(pinHash);
    const sessionToken = req.cookies.shopprint_session;
    const isAuthenticated = isPinSet && verifySession(sessionToken);

    return {
      pinSet: isPinSet,
      authenticated: isAuthenticated
    };
  });

  // Local loopback status for desktop tray app
  fastify.get('/api/tray/status', async (req, reply) => {
    const ip = req.ip || '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1') && ip !== 'localhost') {
      return reply.code(403).send({ error: 'Access denied' });
    }
    const pendingCount = db.prepare(`
      SELECT COUNT(*) as count FROM jobs WHERE status IN ('PENDING_APPROVAL', 'QUEUED')
    `).get().count;

    const latestFailed = db.prepare(`
      SELECT code, failure_reason FROM jobs WHERE status = 'FAILED' ORDER BY id DESC LIMIT 1
    `).get();

    return {
      status: 'ok',
      pendingCount,
      queuePaused: getSetting('queue_paused', 'false') === 'true',
      latestFailed: latestFailed || null
    };
  });

  // Initial PIN setup
  fastify.post('/api/admin/setup-pin', async (req, reply) => {
    const existingPin = getSetting('admin_pin_hash', '');
    if (existingPin) {
      return reply.code(400).send({ error: 'PIN is already configured.' });
    }

    const { pin } = req.body || {};
    if (!pin || pin.toString().length < 4) {
      return reply.code(400).send({ error: 'PIN must be at least 4 digits.' });
    }

    const hashed = hashPin(pin.toString());
    setSetting('admin_pin_hash', hashed);

    const session = generateSessionToken();
    reply.setCookie('shopprint_session', session, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 // 30 days
    });

    return { success: true };
  });

  // Admin login
  fastify.post('/api/admin/login', async (req, reply) => {
    const { pin } = req.body || {};
    const storedHash = getSetting('admin_pin_hash', '');

    if (!storedHash) {
      return reply.code(400).send({ error: 'PIN not set yet. Please set up initial PIN.' });
    }

    if (!pin || !verifyPin(pin.toString(), storedHash)) {
      return reply.code(401).send({ error: 'Incorrect PIN.' });
    }

    const session = generateSessionToken();
    reply.setCookie('shopprint_session', session, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600
    });

    return { success: true };
  });

  // Admin logout
  fastify.post('/api/admin/logout', async (req, reply) => {
    const sessionToken = req.cookies.shopprint_session;
    if (sessionToken) {
      removeAdminSession(sessionToken);
    }
    reply.clearCookie('shopprint_session', { path: '/' });
    return { success: true };
  });

  // Guard for protected admin actions
  const requireAdmin = async (req, reply) => {
    const sessionToken = req.cookies.shopprint_session;
    if (!verifySession(sessionToken)) {
      return reply.code(401).send({ error: 'Unauthorized. Please sign in with shop PIN.' });
    }
  };

  // Get Admin Dashboard data
  fastify.get('/api/admin/status', { preHandler: requireAdmin }, async (req, reply) => {
    const localIp = getLocalIP();
    const configuredPublicUrl = getSetting('public_url', '').trim();
    const serverUrl = configuredPublicUrl || `http://${localIp}:${CONFIG.PORT}`;
    const qrDataUrl = await QRCode.toDataURL(serverUrl, { margin: 1, width: 300 });

    const printers = await getPrinters();
    const selectedPrinter = getSetting('selected_printer', printers[0]?.name || '');
    const autoPrint = getSetting('auto_print', 'false') === 'true';
    const queuePaused = getSetting('queue_paused', 'false') === 'true';
    const privacyMode = getSetting('privacy_mode', 'false') === 'true';
    const defaultPaperSize = getSetting('default_paper_size', 'A4');
    const defaultFitMode = getSetting('default_fit_mode', 'fit');
    const freeDiskMB = checkFreeDiskMB();

    const jobs = db.prepare(`
      SELECT * FROM jobs 
      ORDER BY id DESC 
      LIMIT 100
    `).all();

    return {
      serverUrl,
      localIp,
      publicUrl: configuredPublicUrl,
      qrDataUrl,
      printers,
      selectedPrinter,
      autoPrint,
      queuePaused,
      privacyMode,
      defaultPaperSize,
      defaultFitMode,
      allowDuplex: getSetting('allow_duplex', 'true') === 'true',
      allowColor: getSetting('allow_color', 'true') === 'true',
      allow2on1: getSetting('allow_2on1', 'true') === 'true',
      allowOrientation: getSetting('allow_orientation', 'true') === 'true',
      allowCustomPages: getSetting('allow_custom_pages', 'true') === 'true',
      allowCopies: getSetting('allow_copies', 'true') === 'true',
      maxCopies: parseInt(getSetting('max_copies', '20'), 10) || 20,
      allowPaperSize: getSetting('allow_paper_size', 'false') === 'true',
      defaultDuplex: getSetting('default_duplex', 'simplex'),
      defaultColor: getSetting('default_color', 'monochrome'),
      shopName: getSetting('shop_name', 'ShopPrint Station'),
      enablePricing: getSetting('enable_pricing', 'true') === 'true',
      priceBwPerPage: getSetting('price_bw_per_page', '2.00'),
      priceColorPerPage: getSetting('price_color_per_page', '10.00'),
      priceDuplexDiscount: getSetting('price_duplex_discount', '0.50'),
      freeDiskMB,
      jobs
    };
  });

  // Update Settings
  fastify.post('/api/admin/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const {
      autoPrint, selectedPrinter, queuePaused, privacyMode, defaultPaperSize, defaultFitMode, publicUrl,
      allowDuplex, allowColor, allow2on1, allowOrientation, allowCustomPages, allowCopies, maxCopies,
      allowPaperSize, defaultDuplex, defaultColor, shopName, enablePricing, priceBwPerPage, priceColorPerPage, priceDuplexDiscount
    } = req.body || {};

    if (autoPrint !== undefined) setSetting('auto_print', autoPrint ? 'true' : 'false');
    if (selectedPrinter !== undefined) setSetting('selected_printer', selectedPrinter);
    if (privacyMode !== undefined) setSetting('privacy_mode', privacyMode ? 'true' : 'false');
    if (defaultPaperSize !== undefined) setSetting('default_paper_size', defaultPaperSize);
    if (defaultFitMode !== undefined) setSetting('default_fit_mode', defaultFitMode);
    if (publicUrl !== undefined) setSetting('public_url', publicUrl.trim());

    if (allowDuplex !== undefined) setSetting('allow_duplex', allowDuplex ? 'true' : 'false');
    if (allowColor !== undefined) setSetting('allow_color', allowColor ? 'true' : 'false');
    if (allow2on1 !== undefined) setSetting('allow_2on1', allow2on1 ? 'true' : 'false');
    if (allowOrientation !== undefined) setSetting('allow_orientation', allowOrientation ? 'true' : 'false');
    if (allowCustomPages !== undefined) setSetting('allow_custom_pages', allowCustomPages ? 'true' : 'false');
    if (allowCopies !== undefined) setSetting('allow_copies', allowCopies ? 'true' : 'false');
    if (maxCopies !== undefined) setSetting('max_copies', String(Math.max(1, parseInt(maxCopies, 10) || 20)));
    if (allowPaperSize !== undefined) setSetting('allow_paper_size', allowPaperSize ? 'true' : 'false');
    if (defaultDuplex !== undefined) setSetting('default_duplex', defaultDuplex === 'duplexlong' ? 'duplexlong' : 'simplex');
    if (defaultColor !== undefined) setSetting('default_color', defaultColor === 'color' ? 'color' : 'monochrome');
    if (shopName !== undefined) setSetting('shop_name', (shopName || '').toString().trim().slice(0, 80));
    if (enablePricing !== undefined) setSetting('enable_pricing', enablePricing ? 'true' : 'false');
    if (priceBwPerPage !== undefined) setSetting('price_bw_per_page', String(Math.max(0, parseFloat(priceBwPerPage) || 0)));
    if (priceColorPerPage !== undefined) setSetting('price_color_per_page', String(Math.max(0, parseFloat(priceColorPerPage) || 0)));
    if (priceDuplexDiscount !== undefined) setSetting('price_duplex_discount', String(Math.max(0, parseFloat(priceDuplexDiscount) || 0)));

    if (queuePaused !== undefined) {
      const prevPaused = getSetting('queue_paused', 'false') === 'true';
      const newPaused = Boolean(queuePaused);
      setSetting('queue_paused', newPaused ? 'true' : 'false');

      // If queue was unpaused, resume processing
      if (prevPaused && !newPaused) {
        processNext();
      }
    }

    queueEvents.emit('settings_updated');
    return { success: true };
  });

  // Actions on Jobs: approve, reject, cancel, retry, reprint
  fastify.post('/api/admin/jobs/:id/action', { preHandler: requireAdmin }, async (req, reply) => {
    const jobId = parseInt(req.params.id, 10);
    const { action } = req.body || {};

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    switch (action) {
      case 'approve': {
        if (job.status !== 'PENDING_APPROVAL') {
          return reply.code(400).send({ error: 'Job is not pending approval.' });
        }
        updateJobStatus(jobId, 'QUEUED', 'Approved by shopkeeper');
        notifyJobUpdate(jobId);
        processNext();
        break;
      }
      case 'reject': {
        if (job.status !== 'PENDING_APPROVAL') {
          return reply.code(400).send({ error: 'Job is not pending approval.' });
        }
        updateJobStatus(jobId, 'REJECTED', 'Rejected by shopkeeper');
        notifyJobUpdate(jobId);
        break;
      }
      case 'cancel': {
        if (job.status !== 'QUEUED' && job.status !== 'PENDING_APPROVAL') {
          return reply.code(400).send({ error: 'Only pending or queued jobs can be cancelled.' });
        }
        updateJobStatus(jobId, 'CANCELLED', 'Cancelled by shopkeeper');
        notifyJobUpdate(jobId);
        break;
      }
      case 'retry': {
        // Reset retry count, clear queue paused if it was set
        db.prepare('UPDATE jobs SET retry_count = 0 WHERE id = ?').run(jobId);
        setSetting('queue_paused', 'false');
        updateJobStatus(jobId, 'QUEUED', 'Manual retry by shopkeeper');
        notifyJobUpdate(jobId);
        processNext();
        break;
      }
      case 'reprint': {
        updateJobStatus(jobId, 'QUEUED', 'Reprint requested by shopkeeper');
        notifyJobUpdate(jobId);
        processNext();
        break;
      }
      default:
        return reply.code(400).send({ error: 'Unknown action.' });
    }

    return { success: true, newStatus: db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status };
  });

  // Edit Job Print Settings (Copies, Color, Duplex, Paper Size, Fit, Name)
  fastify.post('/api/admin/jobs/:id/edit', { preHandler: requireAdmin }, async (req, reply) => {
    const jobId = parseInt(req.params.id, 10);
    const { copies, colorMode, duplexMode, paperSize, fitMode, customerName } = req.body || {};

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (job.status === 'PRINTING') {
      return reply.code(400).send({ error: 'Cannot edit a job while it is actively printing.' });
    }

    const safeCopies = copies ? Math.min(Math.max(parseInt(copies, 10) || 1, 1), 50) : job.copies;
    const safeColor = colorMode === 'color' ? 'color' : (colorMode === 'monochrome' ? 'monochrome' : job.color_mode);
    const safeDuplex = duplexMode === 'duplexlong' ? 'duplexlong' : (duplexMode === 'simplex' ? 'simplex' : job.duplex_mode);
    const allowedPapers = ['A4', 'A3', 'legal', 'letter'];
    const safePaper = allowedPapers.includes(paperSize) ? paperSize : job.paper_size;
    const safeFit = fitMode === 'noscale' ? 'noscale' : (fitMode === 'fit' ? 'fit' : job.fit_mode);
    const safeName = customerName !== undefined ? customerName.toString().trim().slice(0, 50) : job.customer_name;
    const safeOrient = ['portrait', 'landscape', 'auto'].includes(req.body.orientation) ? req.body.orientation : job.orientation;
    const safePagesPerSheet = [1, 2].includes(parseInt(req.body.pagesPerSheet, 10)) ? parseInt(req.body.pagesPerSheet, 10) : job.pages_per_sheet;

    db.prepare(`
      UPDATE jobs 
      SET copies = ?, color_mode = ?, duplex_mode = ?, paper_size = ?, fit_mode = ?, customer_name = ?, orientation = ?, pages_per_sheet = ?, updated_at = ?
      WHERE id = ?
    `).run(
      safeCopies,
      safeColor,
      safeDuplex,
      safePaper,
      safeFit,
      safeName,
      safeOrient,
      safePagesPerSheet,
      new Date().toISOString(),
      jobId
    );

    notifyJobUpdate(jobId);
    return { success: true };
  });

  // Change Admin PIN directly from dashboard
  fastify.post('/api/admin/change-pin', { preHandler: requireAdmin }, async (req, reply) => {
    const { currentPin, newPin } = req.body || {};
    const storedHash = getSetting('admin_pin_hash', '');

    if (currentPin && storedHash && !verifyPin(currentPin.toString().trim(), storedHash)) {
      return reply.code(400).send({ error: 'Current PIN is incorrect.' });
    }

    const cleanNewPin = (newPin || '').toString().trim();
    if (cleanNewPin.length < 4) {
      return reply.code(400).send({ error: 'New PIN must be at least 4 digits.' });
    }

    const hashed = hashPin(cleanNewPin);
    setSetting('admin_pin_hash', hashed);
    return { success: true, message: 'Admin PIN updated successfully.' };
  });

  // Clear & delete all print jobs and purge uploaded files
  fastify.post('/api/admin/clear-all', { preHandler: requireAdmin }, async (req, reply) => {
    // 1. Purge all upload files from disk
    if (fs.existsSync(CONFIG.UPLOADS_DIR)) {
      try {
        const files = fs.readdirSync(CONFIG.UPLOADS_DIR);
        for (const f of files) {
          try { fs.unlinkSync(path.join(CONFIG.UPLOADS_DIR, f)); } catch {}
        }
      } catch {}
    }

    // 2. Clear mock output files
    if (fs.existsSync(CONFIG.MOCK_OUTPUT_DIR)) {
      try {
        const mockFiles = fs.readdirSync(CONFIG.MOCK_OUTPUT_DIR);
        for (const f of mockFiles) {
          try { fs.unlinkSync(path.join(CONFIG.MOCK_OUTPUT_DIR, f)); } catch {}
        }
      } catch {}
    }

    // 3. Clear database tables
    const count = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get().cnt;
    db.exec('DELETE FROM job_history; DELETE FROM jobs;');

    logger.info({ clearedJobsCount: count }, 'Shopkeeper purged all print jobs and storage.');

    // 4. Purge Windows Print Spooler queue so NO surprise prints occur
    if (process.platform === 'win32') {
      try {
        const { exec } = await import('child_process');
        exec('powershell -NoProfile -Command "Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue }"', { timeout: 8000 });
      } catch {}
    }

    // 5. Notify admin & listeners
    queueEvents.emit('settings_updated');

    return { success: true, clearedCount: count };
  });

  // Purge Windows Print Spooler (cancels stuck/retained print jobs across all printers)
  fastify.post('/api/admin/spooler/clear', { preHandler: requireAdmin }, async (req, reply) => {
    if (process.platform === 'win32') {
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec(
            'powershell -NoProfile -Command "Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue }"',
            { timeout: 8000 },
            () => resolve()
          );
        });
      } catch {}
    }
    return { success: true, message: 'Windows Print Spooler cleared — all stuck/pending jobs cancelled.' };
  });

  // ============================================================
  // Tunnel Management API
  // ============================================================

  // GET /api/admin/tunnel — return current tunnel state
  fastify.get('/api/admin/tunnel', { preHandler: requireAdmin }, async (req, reply) => {
    const tokenPath  = path.join(CONFIG.ROOT_DIR, 'bin', 'tunnel_token.txt');
    const hasToken   = fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, 'utf8').trim().length > 10;
    const publicUrl  = getSetting('public_url', '');
    const tunnelId   = getSetting('tunnel_id', '');

    // Check if cloudflared process is alive
    let connected = false;
    try {
      const { execSync } = await import('child_process');
      const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH', { timeout: 3000 }).toString();
      connected = out.toLowerCase().includes('cloudflared.exe');
    } catch {}

    return { hasToken, publicUrl, tunnelId, connected };
  });

  // POST /api/admin/tunnel/save — save token + publicUrl, restart cloudflared
  fastify.post('/api/admin/tunnel/save', { preHandler: requireAdmin }, async (req, reply) => {
    const { token, publicUrl } = req.body || {};
    let cleanToken = (token || '').trim();
    // Auto-extract JWT if user pasted full command: cloudflared.exe service install <TOKEN>
    const tokenMatch = cleanToken.match(/eyJh[A-Za-z0-9_-]+/);
    if (tokenMatch) {
      cleanToken = tokenMatch[0];
    }

    if (!cleanToken || cleanToken.length < 20) {
      return reply.code(400).send({ error: 'Invalid token. Please copy the token string from Cloudflare.' });
    }

    const installDir = CONFIG.ROOT_DIR;
    const binDir     = path.join(installDir, 'bin');
    const tokenPath  = path.join(binDir, 'tunnel_token.txt');
    const cfExe      = path.join(binDir, 'cloudflared.exe');

    // Save token file
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(tokenPath, cleanToken, 'utf8');

    // Save public_url and extract tunnel ID from token (JWT middle section)
    if (publicUrl) {
      setSetting('public_url', publicUrl.trim());
      queueEvents.emit('settings_updated');
    }

    // Extract tunnel ID from JWT token payload
    try {
      const payload = JSON.parse(Buffer.from(cleanToken.split('.')[1] || '', 'base64').toString());
      if (payload.t) setSetting('tunnel_id', payload.t);
    } catch {}

    // Kill existing cloudflared and restart
    if (fs.existsSync(cfExe)) {
      try {
        const { execSync } = await import('child_process');
        try { execSync('taskkill /F /IM cloudflared.exe', { timeout: 3000 }); } catch {}
        await new Promise(r => setTimeout(r, 1000));

        const { spawn } = await import('child_process');
        const child = spawn(cfExe, ['tunnel', '--protocol', 'http2', 'run', '--token', cleanToken], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.unref();
        logger.info(`Cloudflared restarted PID: ${child.pid} using HTTP/2`);
      } catch (e) {
        logger.error('Failed to restart cloudflared:', e.message);
      }
    }

    return { success: true };
  });

  // POST /api/admin/tunnel/clear — remove token, stop cloudflared
  fastify.post('/api/admin/tunnel/clear', { preHandler: requireAdmin }, async (req, reply) => {
    const installDir = CONFIG.ROOT_DIR;
    const tokenPath  = path.join(installDir, 'bin', 'tunnel_token.txt');
    try {
      if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
      const { execSync } = await import('child_process');
      try { execSync('taskkill /F /IM cloudflared.exe', { timeout: 3000 }); } catch {}
    } catch {}
    return { success: true };
  });

  // POST /api/admin/tunnel/test — server-side test if the public URL is reachable
  fastify.post('/api/admin/tunnel/test', { preHandler: requireAdmin }, async (req, reply) => {
    const { url } = req.body || {};
    if (!url || !url.startsWith('http')) {
      return reply.code(400).send({ error: 'Invalid URL' });
    }
    try {
      const https = await import('https');
      const http  = await import('http');
      const mod   = url.startsWith('https') ? https : http;

      const statusCode = await new Promise((resolve, reject) => {
        const req2 = mod.get(url, { timeout: 8000 }, (res) => {
          res.destroy();
          resolve(res.statusCode);
        });
        req2.on('error', reject);
        req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout')); });
      });

      const ok = statusCode >= 200 && statusCode < 500 && statusCode !== 404;
      return { ok, statusCode };
    } catch (e) {
      return { ok: false, statusCode: 0, error: e.message };
    }
  });

  // Admin SSE for real-time dashboard events
  fastify.get('/api/admin/sse', { preHandler: requireAdmin }, async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const sendEvent = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onJobIncoming = (data) => {
      sendEvent('job_incoming', data);
      sendEvent('job_update', data);
      sendEvent('job_updated', data);
    };
    const onJobUpdate = (job) => {
      sendEvent('job_update', job);
      sendEvent('job_updated', job);
    };
    const onJobNeedsApproval = (data) => {
      sendEvent('job_needs_approval', data);
      sendEvent('job_update', data);
      sendEvent('job_updated', data);
    };
    const onPrinterAlert = (data) => sendEvent('printer_alert', data);
    const onSettingsUpdate = () => {
      sendEvent('settings_update', {});
      sendEvent('settings_updated', {});
    };

    queueEvents.on('job_incoming', onJobIncoming);
    queueEvents.on('job_updated', onJobUpdate);
    queueEvents.on('job_needs_approval', onJobNeedsApproval);
    queueEvents.on('printer_alert', onPrinterAlert);
    queueEvents.on('settings_updated', onSettingsUpdate);

    const pingInterval = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 20000);

    req.raw.on('close', () => {
      clearInterval(pingInterval);
      queueEvents.off('job_incoming', onJobIncoming);
      queueEvents.off('job_updated', onJobUpdate);
      queueEvents.off('job_needs_approval', onJobNeedsApproval);
      queueEvents.off('printer_alert', onPrinterAlert);
      queueEvents.off('settings_updated', onSettingsUpdate);
    });
  });
}
