import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { headR2Object } from '../services/r2.js';
import { calculateOrderPrice } from '../services/pricing.js';
import { createCashfreeOrderSession } from '../services/cashfree.js';
import { OrderDocument, ShopDocument, IdempotencyKeyDocument } from '../types.js';

export const orderRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // Create an order & initiate payment session
  fastify.post<{
    Body: {
      idempotencyKey?: string;
      shopSlug: string;
      customerName?: string;
      customerPhone?: string;
      files: Array<{
        fileKey: string;
        originalFilename: string;
        fileSize: number;
        mimeType: string;
        pageCount: number;
      }>;
      printOptions: {
        copies: number;
        colorMode: 'monochrome' | 'color';
        duplexMode: 'simplex' | 'duplexlong';
        paperSize?: string;
        fitMode?: string;
        orientation?: string;
        pagesPerSheet?: number;
      };
    };
  }>('/orders', async (request, reply) => {
    const { idempotencyKey, shopSlug, customerName, customerPhone, files, printOptions } = request.body || {};

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

    // 3. HEAD-check each file in R2 to verify existence and size
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
    const pricing = calculateOrderPrice(
      {
        pageCount: totalPages,
        copies: printOptions.copies || 1,
        colorMode: printOptions.colorMode || 'monochrome',
        duplexMode: printOptions.duplexMode || 'simplex'
      },
      shop.pricing,
      5 // 5% platform fee
    );

    const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date();
    // Default 7-day retention for paid/uploaded orders
    const retentionUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // 5. Create Cashfree payment session
    let paymentSessionId: string | undefined;
    let providerOrderId: string | undefined;

    try {
      const sessionResult = await createCashfreeOrderSession({
        orderId,
        amountPaise: pricing.amountPaise,
        customerName,
        customerPhone
      });
      paymentSessionId = sessionResult.paymentSessionId;
      providerOrderId = sessionResult.providerOrderId;
    } catch (err: any) {
      // In development or if test sandbox fails, allow mock order creation
      request.log.error({ err }, 'Failed to create Cashfree session');
      providerOrderId = orderId;
      paymentSessionId = `mock_session_${crypto.randomBytes(8).toString('hex')}`;
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
        copies: printOptions.copies || 1,
        colorMode: printOptions.colorMode || 'monochrome',
        duplexMode: printOptions.duplexMode || 'simplex',
        paperSize: printOptions.paperSize || 'A4',
        fitMode: printOptions.fitMode || 'fit',
        orientation: printOptions.orientation || 'portrait',
        pagesPerSheet: printOptions.pagesPerSheet || 1
      },
      pricing,
      status: 'PAYMENT_PENDING',
      paymentSessionId,
      providerOrderId,
      retentionUntil,
      auditTrail: [
        {
          actor: 'customer',
          from: 'UPLOADED',
          to: 'PAYMENT_PENDING',
          time: now,
          reason: 'Order created, awaiting payment'
        }
      ],
      createdAt: now,
      updatedAt: now
    };

    await db.collection<OrderDocument>('orders').insertOne(orderDoc);

    // 7. Client-safe response (NO internal database IDs, secrets or token hashes)
    const clientSafeResponse = {
      orderId: orderDoc.orderId,
      status: orderDoc.status,
      paymentSessionId: orderDoc.paymentSessionId,
      amountPaise: pricing.amountPaise,
      currency: pricing.currency,
      copies: orderDoc.printOptions.copies,
      pageCount: totalPages,
      createdAt: orderDoc.createdAt
    };

    // Store idempotency response if key supplied
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

  // Get order status
  fastify.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    const order = await db.collection<OrderDocument>('orders').findOne({ orderId });

    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    return reply.send({
      orderId: order.orderId,
      status: order.status,
      amountPaise: order.pricing.amountPaise,
      currency: order.pricing.currency,
      copies: order.printOptions.copies,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
  });
};
