import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { headR2Object } from '../services/r2.js';
import { calculateOrderPrice } from '../services/pricing.js';
import { createCashfreeOrderSession, fetchCashfreeOrderStatus } from '../services/cashfree.js';
import { fulfillPaidOrder } from '../services/paymentFulfillment.js';
import { WebSocketHub } from '../services/wsHub.js';
import { OrderDocument, ShopDocument, IdempotencyKeyDocument, JobDocument, OutboxDocument } from '../types.js';
import { outboxBus } from '../services/outboxWorker.js';

export const orderRoutes: FastifyPluginAsync<{ db: Db; wsHub?: WebSocketHub }> = async (fastify, opts) => {
  const db = opts.db;
  const wsHub = opts.wsHub;

  // Get Shop Info for Customer PWA
  fastify.get<{ Params: { shopSlug: string } }>('/shops/:shopSlug/info', async (request, reply) => {
    const { shopSlug } = request.params;
    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    const isConnected = wsHub ? wsHub.isAgentConnected(shop._id.toString()) : false;

    return reply.send({
      name: shop.name,
      slug: shop.slug,
      pricing: {
        bwRate: (shop.pricing.bwPerPagePaise || 200) / 100,
        colorRate: (shop.pricing.colorPerPagePaise || 1000) / 100,
        duplexDiscount: (shop.pricing.duplexDiscountPaise || 50) / 100,
        bwPerPagePaise: shop.pricing.bwPerPagePaise || 200,
        colorPerPagePaise: shop.pricing.colorPerPagePaise || 1000,
        duplexDiscountPaise: shop.pricing.duplexDiscountPaise || 50
      },
      printOptions: shop.printOptions || {
        allowColor: true,
        allowBW: true,
        allowSimplex: true,
        allowDuplexLong: true,
        allowDuplexShort: false,
        allow2on1: true,
        allowPortrait: true,
        allowLandscape: true,
        defaultColorMode: 'monochrome',
        defaultOrientation: 'portrait',
        defaultDuplex: 'simplex',
        defaultPagesPerSheet: 1,
        maxCopies: 10
      },
      requireCustomerName: shop.requireCustomerName ?? false,
      payAtCounter: shop.payAtCounter ?? false,
      agentOnline: isConnected,
      sandbox: process.env.CASHFREE_ENV === 'SANDBOX'
    });
  });

  // Get Shop QR Code Data URL for Mobile Scanning
  fastify.get<{ Params: { shopSlug: string } }>('/shops/:shopSlug/qr', async (request, reply) => {
    const { shopSlug } = request.params;
    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    // Prioritize configured canonical public URL (e.g. Cloudflare tunnel / custom domain)
    const baseUrl = (process.env.SERVER_BASE_URL || process.env.SERVER_URL || '').replace(/\/+$/, '');
    let shopUrl: string;
    if (baseUrl) {
      shopUrl = `${baseUrl}/shop/${shop.slug}`;
    } else {
      const host = request.headers.host || `localhost:${process.env.PORT || 3000}`;
      const protocol = request.headers['x-forwarded-proto'] || 'http';
      shopUrl = `${protocol}://${host}/shop/${shop.slug}`;
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(shopUrl, {
        margin: 2,
        width: 320,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      });
      return reply.send({ shopUrl, qrDataUrl });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to generate QR code: ' + err.message });
    }
  });

  // Create an order & initiate Cashfree payment session
  fastify.post<{
    Body: {
      idempotencyKey?: string;
      shopSlug: string;
      customerName?: string;
      customerPhone?: string;
      customerNote?: string;
      payAtCounter?: boolean;
      files: Array<{
        fileKey: string;
        originalFilename: string;
        fileSize: number;
        mimeType: string;
        pageCount: number;
        pageRange?: string;
      }>;
      printOptions: {
        copies: number;
        colorMode: 'monochrome' | 'color';
        duplexMode: 'simplex' | 'duplexlong';
        paperSize?: string;
        fitMode?: string;
        orientation?: string;
        pagesPerSheet?: number;
        pageRange?: string;
        stampPaperMode?: boolean;
      };
    };
  }>('/orders', async (request, reply) => {
    const { idempotencyKey, shopSlug, customerName, customerPhone, customerNote, payAtCounter, files, printOptions } = request.body || {};

    if (!shopSlug || !files || !Array.isArray(files) || files.length === 0 || !printOptions) {
      return reply.code(400).send({ error: 'Missing required order parameters' });
    }

    // 1. Check idempotency key if provided
    if (idempotencyKey) {
      const existingKey = await db.collection<IdempotencyKeyDocument>('idempotencyKeys').findOne({
        key: idempotencyKey,
        scope: `order_create_${shopSlug}`
      });
      if (existingKey) {
        return reply.send(existingKey.responsePayload);
      }
    }

    // 2. Fetch active shop
    const shop = await db.collection<ShopDocument>('shops').findOne({ slug: shopSlug, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    // 3. Verify each file in storage
    let totalPages = 0;
    for (const file of files) {
      if (!file.fileKey) {
        return reply.code(400).send({ error: 'File entry missing fileKey' });
      }
      const head = await headR2Object(file.fileKey);
      if (!head.exists) {
        return reply.code(400).send({ error: `File not found in storage: ${file.originalFilename || file.fileKey}` });
      }
      totalPages += Math.max(1, file.pageCount || 1);
    }

    // 4. Server-side pricing calculation in paise
    const platformFeePercent = shop.easySplit?.commissionPercent ?? 5;
    const pricing = calculateOrderPrice(
      {
        pageCount: totalPages,
        copies: Math.min(Math.max(1, printOptions.copies || 1), shop.printOptions?.maxCopies ?? 10),
        colorMode: printOptions.colorMode || 'monochrome',
        duplexMode: printOptions.duplexMode || 'simplex',
        pagesPerSheet: printOptions.pagesPerSheet || 1
      },
      shop.pricing,
      platformFeePercent
    );

    const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date();
    const retentionUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Prepare Easy Split if vendor is configured
    const orderSplitsInput: Array<{ vendor_id: string; amount?: number; percentage?: number }> = [];
    if (shop.easySplit?.vendorId && shop.easySplit.status === 'ACTIVE') {
      const vendorShareRupees = Number((pricing.vendorSharePaise / 100).toFixed(2));
      orderSplitsInput.push({
        vendor_id: shop.easySplit.vendorId,
        amount: vendorShareRupees
      });
    }

    const isPayAtCounter = (shop.payAtCounter === true) || (payAtCounter === true);

    // 5. Payment Session or Pay at Counter
    let paymentSessionId: string | undefined;
    let providerOrderId: string | undefined;

    if (!isPayAtCounter) {
      try {
        const sessionResult = await createCashfreeOrderSession({
          orderId,
          amountPaise: pricing.amountPaise,
          customerName,
          customerPhone,
          orderSplits: orderSplitsInput.length > 0 ? orderSplitsInput : undefined
        });
        paymentSessionId = sessionResult.paymentSessionId;
        providerOrderId = sessionResult.providerOrderId;
      } catch (err: any) {
        request.log.error({ err }, 'Failed to create Cashfree session — returning 503');
        return reply.code(503).send({
          error: 'Payment gateway temporarily unavailable. Please try again in a moment.',
          retryable: true
        });
      }
    }

    // 6. Save order document in MongoDB
    const orderDoc: OrderDocument = {
      _id: new ObjectId(),
      orderId,
      shopId: shop._id,
      customerName,
      customerPhone,
      files,
      printOptions: {
        copies: Math.min(Math.max(1, printOptions.copies || 1), shop.printOptions?.maxCopies ?? 10),
        colorMode: printOptions.colorMode || 'monochrome',
        duplexMode: printOptions.duplexMode || 'simplex',
        pagesPerSheet: printOptions.pagesPerSheet || 1,
        paperSize: printOptions.paperSize || 'A4',
        fitMode: printOptions.fitMode || 'fit',
        orientation: printOptions.orientation || 'portrait',
        stampPaperMode: Boolean(printOptions.stampPaperMode)
      },
      pricing,
      orderSplits: orderSplitsInput.map((s) => ({
        vendorId: s.vendor_id,
        amount: s.amount,
        percentage: s.percentage,
        status: 'CREATED'
      })),
      status: isPayAtCounter ? 'PAY_AT_COUNTER_PENDING' : 'PAYMENT_PENDING',
      payAtCounter: isPayAtCounter,
      paymentSessionId,
      providerOrderId,
      retentionUntil,
      auditTrail: [
        {
          actor: 'customer',
          from: 'UPLOADED',
          to: isPayAtCounter ? 'PAY_AT_COUNTER_PENDING' : 'PAYMENT_PENDING',
          time: now,
          reason: isPayAtCounter ? 'Order created under Pay at Counter mode' : 'Order created, awaiting payment'
        }
      ],
      createdAt: now,
      updatedAt: now
    };

    await db.collection<OrderDocument>('orders').insertOne(orderDoc);

    let jobId: string | undefined;

    if (isPayAtCounter) {
      jobId = `job_${orderDoc.orderId}`;
      const jobDoc: JobDocument = {
        _id: new ObjectId(),
        jobId,
        orderId: orderDoc.orderId,
        shopId: orderDoc.shopId,
        status: 'QUEUED',
        retryCount: 0,
        auditTrail: [
          {
            actor: 'system',
            from: 'PAY_AT_COUNTER_PENDING',
            to: 'QUEUED',
            time: now,
            reason: 'Pay at counter order created, queued for print confirmation'
          }
        ],
        createdAt: now,
        updatedAt: now
      };
      await db.collection<JobDocument>('jobs').insertOne(jobDoc);

      await db.collection<OutboxDocument>('outbox').insertOne({
        _id: new ObjectId(),
        jobId,
        shopId: orderDoc.shopId,
        payload: {
          type: 'job',
          id: jobId,
          op: 'PRINT_JOB',
          payAtCounter: true
        },
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now
      });

      outboxBus.emit('outbox:new');

      if (wsHub) {
        wsHub.sendJobHint(orderDoc.shopId.toString(), jobId, { payAtCounter: true });
      }
    }

    // 7. Client-safe response
    const clientSafeResponse = {
      orderId: orderDoc.orderId,
      status: orderDoc.status,
      jobId,
      payAtCounter: isPayAtCounter,
      paymentSessionId: orderDoc.paymentSessionId,
      amountPaise: pricing.amountPaise,
      amountRupees: (pricing.amountPaise / 100).toFixed(2),
      currency: pricing.currency,
      copies: orderDoc.printOptions.copies,
      pageCount: totalPages,
      cashfreeEnv: process.env.CASHFREE_ENV || 'SANDBOX',
      createdAt: orderDoc.createdAt
    };

    if (idempotencyKey) {
      await db.collection<IdempotencyKeyDocument>('idempotencyKeys').insertOne({
        _id: new ObjectId(),
        key: idempotencyKey,
        scope: `order_create_${shopSlug}`,
        responsePayload: clientSafeResponse,
        createdAt: now
      });
    }

    return reply.code(201).send(clientSafeResponse);
  });

  // Verify Payment Status (Polled or called by frontend after Cashfree SDK modal completes)
  fastify.post<{ Params: { orderId: string } }>('/orders/:orderId/verify-payment', async (request, reply) => {
    const { orderId } = request.params;
    const order = await db.collection<OrderDocument>('orders').findOne({ orderId });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    if (['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'].includes(order.status)) {
      const job = await db.collection<JobDocument>('jobs').findOne({ orderId });
      return reply.send({
        orderId: order.orderId,
        status: order.status,
        jobStatus: job?.status || 'QUEUED',
        jobId: job?.jobId,
        isPaid: true
      });
    }

    // Check with Cashfree API
    try {
      const cfStatus = await fetchCashfreeOrderStatus(order.providerOrderId || order.orderId);
      if (cfStatus.orderStatus === 'PAID') {
        const fulfill = await fulfillPaidOrder({
          db,
          orderId: order.orderId,
          providerPaymentId: cfStatus.cfOrderId,
          providerEventId: `verify_${Date.now()}`,
          rawPayload: cfStatus.paymentDetails,
          wsHub,
          reason: 'Verified through Cashfree API callback'
        });

        const job = await db.collection<JobDocument>('jobs').findOne({ orderId });
        return reply.send({
          orderId: order.orderId,
          status: 'PAID',
          jobStatus: job?.status || 'QUEUED',
          jobId: fulfill.jobId,
          isPaid: true
        });
      }

      return reply.send({
        orderId: order.orderId,
        status: order.status,
        cashfreeStatus: cfStatus.orderStatus,
        isPaid: false
      });
    } catch (err: any) {
      return reply.send({
        orderId: order.orderId,
        status: order.status,
        isPaid: false,
        error: err.message
      });
    }
  });

  // Sandbox Test Payment Simulation (Only active when CASHFREE_ENV === 'SANDBOX')
  fastify.post<{ Params: { orderId: string } }>('/orders/:orderId/simulate-sandbox-payment', async (request, reply) => {
    if (process.env.CASHFREE_ENV !== 'SANDBOX') {
      return reply.code(403).send({ error: 'Sandbox simulation only permitted in SANDBOX mode' });
    }

    const { orderId } = request.params;
    const order = await db.collection<OrderDocument>('orders').findOne({ orderId });
    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    const fulfill = await fulfillPaidOrder({
      db,
      orderId: order.orderId,
      providerPaymentId: `sim_pay_${Date.now()}`,
      providerEventId: `sim_evt_${Date.now()}`,
      rawPayload: { simulated: true, mode: 'SANDBOX_ONE_CLICK' },
      wsHub,
      reason: 'Sandbox 1-Click Test Payment'
    });

    const job = await db.collection<JobDocument>('jobs').findOne({ orderId });
    return reply.send({
      success: true,
      orderId: order.orderId,
      status: 'PAID',
      jobStatus: job?.status || 'QUEUED',
      jobId: fulfill.jobId,
      isPaid: true
    });
  });

  // Get order status
  fastify.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    const order = await db.collection<OrderDocument>('orders').findOne({ orderId });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    const job = await db.collection<JobDocument>('jobs').findOne({ orderId });

    // Calculate queue position if job is in waiting state
    let queuePosition = 0;
    if (job && ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED'].includes(job.status)) {
      queuePosition = await db.collection<JobDocument>('jobs').countDocuments({
        shopId: order.shopId,
        status: { $in: ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED'] },
        createdAt: { $lt: job.createdAt }
      }) + 1;
    }

    return reply.send({
      orderId: order.orderId,
      status: order.status,
      jobStatus: job?.status,
      jobId: job?.jobId,
      payAtCounter: (order as any).payAtCounter ?? false,
      queuePosition: queuePosition > 0 ? queuePosition : undefined,
      failureReason: job?.failureReason,
      amountPaise: order.pricing.amountPaise,
      amountRupees: (order.pricing.amountPaise / 100).toFixed(2),
      currency: order.pricing.currency,
      copies: order.printOptions.copies,
      files: order.files.map(f => ({
        originalFilename: f.originalFilename,
        pageCount: f.pageCount,
        fileSize: f.fileSize,
        pageRange: (f as any).pageRange
      })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
  });
};
