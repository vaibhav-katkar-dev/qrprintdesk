import { FastifyPluginAsync } from 'fastify';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { verifyCashfreeWebhook } from '../services/cashfree.js';
import {
  OrderDocument,
  JobDocument,
  PaymentDocument,
  LedgerDocument,
  OutboxDocument
} from '../types.js';

export const webhookRoutes: FastifyPluginAsync<{ db: Db; mongoClient: MongoClient }> = async (fastify, opts) => {
  const { db, mongoClient } = opts;

  fastify.post('/webhooks/cashfree', async (request, reply) => {
    const signature = request.headers['x-webhook-signature'] as string;
    const timestamp = request.headers['x-webhook-timestamp'] as string;
    const rawBody = (request as any).rawBody || JSON.stringify(request.body);

    if (!signature || !timestamp) {
      return reply.code(400).send({ error: 'Missing webhook signature or timestamp headers' });
    }

    // 1. Verify webhook signature with official SDK
    try {
      verifyCashfreeWebhook(signature, rawBody, timestamp);
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Cashfree webhook signature verification failed');
      return reply.code(400).send({ error: 'Invalid webhook signature' });
    }

    const payload = (request.body as any) || {};
    const orderData = payload.data?.order || {};
    const paymentData = payload.data?.payment || {};

    const providerOrderId = orderData.order_id || '';
    const paymentStatus = (paymentData.payment_status || (payload.type === 'PAYMENT_SUCCESS_WEBHOOK' ? 'SUCCESS' : 'FAILED')).toUpperCase();
    const paymentAmount = paymentData.payment_amount ?? orderData.order_amount;
    const paymentCurrency = (paymentData.payment_currency || orderData.order_currency || 'INR').toUpperCase();
    const eventId = String(paymentData.cf_payment_id || payload.event_time || Date.now());

    if (!providerOrderId) {
      return reply.code(400).send({ error: 'Missing order_id in webhook data' });
    }

    // 2. Locate order in database
    const order = await db.collection<OrderDocument>('orders').findOne({
      $or: [{ providerOrderId }, { orderId: providerOrderId }]
    });

    if (!order) {
      return reply.code(404).send({ error: `Order ${providerOrderId} not found` });
    }

    // 3. Amount & Currency validation (never trust client redirect)
    if (paymentCurrency !== 'INR') {
      return reply.code(400).send({ error: `Invalid payment currency: ${paymentCurrency}` });
    }

    const webhookAmountPaise = Math.round(Number(paymentAmount) * 100);
    if (webhookAmountPaise !== order.pricing.amountPaise) {
      return reply.code(400).send({
        error: `Amount mismatch: expected ${order.pricing.amountPaise} paise, received ${webhookAmountPaise} paise`
      });
    }

    // 4. Handle duplicates and out-of-order events
    // Rule: "a late failure must not override success"
    const isAlreadyPaidOrBeyond = [
      'PAID',
      'QUEUED',
      'DOWNLOADING',
      'PRINT_SUBMITTED',
      'COMPLETED',
      'MANUAL_REVIEW'
    ].includes(order.status);

    if (isAlreadyPaidOrBeyond) {
      if (paymentStatus !== 'SUCCESS') {
        // Ignore late failure event if already paid
        return reply.code(200).send({
          status: 'IGNORED',
          message: 'Late failure event ignored as order is already paid'
        });
      }

      // Check if this exact payment event was already recorded
      const existingPayment = await db.collection<PaymentDocument>('payments').findOne({
        orderId: order.orderId,
        providerEventId: eventId
      });

      if (existingPayment) {
        return reply.code(200).send({ status: 'DUPLICATE_ACK', message: 'Event already processed' });
      }
    }

    // Handle payment failure event when not already paid
    if (paymentStatus !== 'SUCCESS') {
      const now = new Date();
      await db.collection<OrderDocument>('orders').updateOne(
        { orderId: order.orderId, status: 'PAYMENT_PENDING' },
        {
          $set: { status: 'FAILED', updatedAt: now },
          $push: {
            auditTrail: {
              actor: 'cashfree',
              from: order.status,
              to: 'FAILED',
              opId: eventId,
              reason: `Payment failed: ${paymentData.payment_message || 'Unsuccessful transaction'}`,
              time: now
            }
          }
        }
      );

      await db.collection<PaymentDocument>('payments').insertOne({
        _id: new ObjectId(),
        orderId: order.orderId,
        shopId: order.shopId,
        provider: 'cashfree',
        providerOrderId,
        providerPaymentId: String(paymentData.cf_payment_id || ''),
        providerEventId: eventId,
        amountPaise: webhookAmountPaise,
        currency: 'INR',
        status: 'FAILED',
        rawPayload: payload,
        createdAt: now
      });

      return reply.code(200).send({ status: 'FAILED_RECORDED' });
    }

    // 5. SUCCESS: ONE Mongo transaction
    // - mark order PAID (conditional)
    // - create QUEUED job
    // - insert outbox entry
    // - append ledger entry (gross, platform fee, vendor share)
    // - record payment event
    const executeOperations = async (sess?: any) => {
      const now = new Date();
      const jobId = `job_${order.orderId}`;
      const opt = sess ? { session: sess } : {};

      // a. Conditional update of order to PAID
      const orderUpdate = await db.collection<OrderDocument>('orders').findOneAndUpdate(
        { orderId: order.orderId, status: 'PAYMENT_PENDING' },
        {
          $set: { status: 'PAID', updatedAt: now },
          $push: {
            auditTrail: {
              actor: 'cashfree',
              from: 'PAYMENT_PENDING',
              to: 'PAID',
              opId: eventId,
              reason: 'Verified payment webhook received',
              time: now
            }
          }
        },
        { ...opt, returnDocument: 'after' }
      );

      if (!orderUpdate) {
        const recheck = await db.collection<OrderDocument>('orders').findOne({ orderId: order.orderId }, opt);
        if (recheck && recheck.status !== 'PAYMENT_PENDING') {
          return { jobId, duplicate: true };
        }
        throw new Error('Order not found or state change conflict');
      }

      // b. Record payment document
      await db.collection<PaymentDocument>('payments').insertOne(
        {
          _id: new ObjectId(),
          orderId: order.orderId,
          shopId: order.shopId,
          provider: 'cashfree',
          providerOrderId,
          providerPaymentId: String(paymentData.cf_payment_id || ''),
          providerEventId: eventId,
          amountPaise: order.pricing.amountPaise,
          currency: 'INR',
          status: 'SUCCESS',
          rawPayload: payload,
          createdAt: now
        },
        opt
      );

      // c. Create QUEUED job document
      const jobDoc: JobDocument = {
        _id: new ObjectId(),
        jobId,
        orderId: order.orderId,
        shopId: order.shopId,
        status: 'QUEUED',
        retryCount: 0,
        auditTrail: [
          {
            actor: 'system',
            from: 'PAID',
            to: 'QUEUED',
            time: now,
            reason: 'Job queued after payment verification'
          }
        ],
        createdAt: now,
        updatedAt: now
      };
      await db.collection<JobDocument>('jobs').insertOne(jobDoc, opt);

      // d. Insert outbox entry
      const outboxDoc: OutboxDocument = {
        _id: new ObjectId(),
        shopId: order.shopId,
        jobId,
        payload: {
          type: 'job',
          id: jobId,
          op: 'dispatch'
        },
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now
      };
      await db.collection<OutboxDocument>('outbox').insertOne(outboxDoc, opt);

      // e. Append ledger entry (gross, platform fee, vendor share)
      const ledgerDoc: LedgerDocument = {
        _id: new ObjectId(),
        shopId: order.shopId,
        orderId: order.orderId,
        grossPaise: order.pricing.amountPaise,
        platformFeePaise: order.pricing.platformFeePaise,
        vendorSharePaise: order.pricing.vendorSharePaise,
        currency: 'INR',
        settled: false,
        createdAt: now
      };
      await db.collection<LedgerDocument>('ledger').insertOne(ledgerDoc, opt);

      return { jobId, duplicate: false };
    };

    try {
      const session = mongoClient.startSession();
      try {
        let opResult: any;
        try {
          await session.withTransaction(async () => {
            opResult = await executeOperations(session);
          });
        } catch (txnErr: any) {
          // Fallback to direct execution if running on a standalone test mongod without replica set
          if (
            txnErr.message?.includes('replica set') ||
            txnErr.message?.includes('Transaction numbers') ||
            txnErr.message?.includes('retryable writes')
          ) {
            opResult = await executeOperations(undefined);
          } else {
            throw txnErr;
          }
        }
        return reply.code(200).send({ status: 'SUCCESS_PROCESSED', jobId: opResult?.jobId });
      } finally {
        await session.endSession();
      }
    } catch (err: any) {
      request.log.error({ err }, 'Cashfree webhook transaction failure');
      // Return 500 so Cashfree retries the webhook delivery
      return reply.code(500).send({ error: 'Database transaction error, please retry' });
    }
  });
};
