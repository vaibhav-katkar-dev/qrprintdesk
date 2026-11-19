import { FastifyPluginAsync } from 'fastify';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { verifyCashfreeWebhook } from '../services/cashfree.js';
import { verifyPayUResponseHash, getPayUCredentials } from '../services/payu.js';
import { fulfillPaidOrder } from '../services/paymentFulfillment.js';
import { transitionJobState } from '../services/stateMachine.js';
import { upgradeShopSubscription } from '../services/subscription.js';
import { WebSocketHub } from '../services/wsHub.js';
import { OrderDocument, PaymentDocument, ShopDocument, JobDocument } from '../types.js';

export const webhookRoutes: FastifyPluginAsync<{ db: Db; mongoClient: MongoClient; wsHub?: WebSocketHub }> = async (fastify, opts) => {
  const { db, wsHub } = opts;

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
    const webhookType = (payload.type || '').toUpperCase();

    // Handle Cashfree Easy Split Settlement Webhooks
    if (webhookType.startsWith('VENDOR_SETTLEMENT_') || webhookType.includes('SETTLEMENT')) {
      const data = payload.data || {};
      const vendorId = data.vendor_id || data.vendorId || '';
      const settlementId = String(data.settlement_id || data.cf_settlement_id || data.transfer_id || Date.now());
      const amountRupees = Number(data.settlement_amount || data.amount || 0);
      const orderId = data.order_id || undefined;
      const failureReason = data.failure_reason || data.remarks || undefined;

      let settlementStatus: 'INITIATED' | 'SUCCESS' | 'FAILED' | 'REVERSED' = 'INITIATED';
      if (webhookType === 'VENDOR_SETTLEMENT_SUCCESS') settlementStatus = 'SUCCESS';
      else if (webhookType === 'VENDOR_SETTLEMENT_FAILED') settlementStatus = 'FAILED';
      else if (webhookType === 'VENDOR_SETTLEMENT_REVERSED') settlementStatus = 'REVERSED';

      // Find shop matching vendorId if present
      const shop = vendorId ? await db.collection<ShopDocument>('shops').findOne({ 'easySplit.vendorId': vendorId }) : null;

      // 1. Record in settlements collection
      await db.collection('settlements').updateOne(
        { settlementId },
        {
          $set: {
            settlementId,
            vendorId,
            shopId: shop?._id,
            orderId,
            eventType: webhookType,
            amountRupees,
            status: settlementStatus,
            rawWebhookData: payload,
            failureReason,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      // 2. If tied to an order, update order split status
      if (orderId && vendorId) {
        await db.collection<OrderDocument>('orders').updateOne(
          {
            $or: [{ orderId }, { providerOrderId: orderId }],
            'orderSplits.vendorId': vendorId
          },
          {
            $set: {
              'orderSplits.$.status': settlementStatus === 'SUCCESS' ? 'SETTLED' : settlementStatus,
              'orderSplits.$.settlementTxnId': settlementId,
              updatedAt: new Date()
            }
          }
        );
      }

      request.log.info({ webhookType, vendorId, settlementId, amountRupees }, 'Easy Split settlement webhook processed');
      return reply.code(200).send({ status: 'SETTLEMENT_RECORDED', settlementId, eventType: webhookType });
    }

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
      // Return 200 so Cashfree stops retrying; unknown orders are safely ignored
      request.log.warn({ providerOrderId }, 'Webhook received for unknown order — acknowledged and ignored');
      return reply.code(200).send({ status: 'IGNORED', reason: 'order_not_found' });
    }

    // 3. Amount & Currency validation
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
        return reply.code(200).send({
          status: 'IGNORED',
          message: 'Late failure event ignored as order is already paid'
        });
      }
      return reply.code(200).send({ status: 'DUPLICATE_ACK', message: 'Event already processed' });
    }

    // Handle payment failure event
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

    // 5. SUCCESS: Fulfill paid order, queue job, dispatch WS hint to Windows agent
    const fulfillResult = await fulfillPaidOrder({
      db,
      orderId: order.orderId,
      providerPaymentId: String(paymentData.cf_payment_id || ''),
      providerEventId: eventId,
      rawPayload: payload,
      wsHub,
      reason: 'Verified Cashfree payment webhook received'
    });

    return reply.code(200).send({ status: 'SUCCESS_PROCESSED', jobId: fulfillResult.jobId });
  });

  // ── PayU Webhook Health Check / Test Endpoint ────────────────────────────
  fastify.get('/webhooks/payu', async (request, reply) => {
    return reply.code(200).send({
      status: 'active',
      gateway: 'payu',
      endpoint: '/api/webhooks/payu',
      methods: ['POST'],
      message: 'PayU webhook listener is live and healthy'
    });
  });

  // ── PayU Webhook Endpoint ──────────────────────────────────────────────────
  fastify.post('/webhooks/payu', async (request, reply) => {
    const payload = (request.body as any) || {};
    const eventName = String(payload.event || payload.action || '').toLowerCase();
    const status = String(payload.status || eventName || '').toLowerCase();
    const txnid = String(payload.txnid || payload.merchantTransactionId || payload.orderId || '').trim();
    const receivedHash = String(payload.hash || '').trim();

    request.log.info({ txnid, status, event: payload.event }, 'PayU webhook received');

    if (!txnid) {
      return reply.code(400).send({ error: 'Missing txnid in PayU webhook' });
    }

    const creds = getPayUCredentials();

    // 1. Verify PayU reverse SHA-512 hash if hash is provided
    if (receivedHash) {
      const isValid = verifyPayUResponseHash({
        receivedHash,
        status: payload.status ? String(payload.status).toLowerCase() : status,
        txnid,
        amount: String(payload.amount || ''),
        productinfo: String(payload.productinfo || ''),
        firstname: String(payload.firstname || ''),
        email: String(payload.email || ''),
        key: String(payload.key || creds.merchantKey),
        salt: creds.merchantSalt,
        udf1: payload.udf1,
        udf2: payload.udf2,
        udf3: payload.udf3,
        udf4: payload.udf4,
        udf5: payload.udf5,
        additionalCharges: payload.additionalCharges
      });

      if (!isValid) {
        request.log.warn({ txnid, status }, 'PayU webhook hash verification failed');
        return reply.code(400).send({ error: 'Invalid PayU hash signature' });
      }
    }

    const eventId = String(payload.payuid || payload.mihpayid || payload.paymentId || `payu_${Date.now()}`);
    const isRefund = status.includes('refund') || eventName.includes('refund');
    const isSuccess = status === 'success' || status === 'successful' || eventName === 'successful';

    // 2. Check if this is a Vendor Subscription Upgrade Payment
    if (payload.udf2 === 'SUBSCRIPTION_UPGRADE' && isSuccess) {
      const shopId = payload.udf5;
      const planId = (payload.udf3 || 'STARTER').toUpperCase() as any;
      const billingCycle = (payload.udf4 || 'monthly').toLowerCase() as any;

      if (shopId && ObjectId.isValid(shopId)) {
        await upgradeShopSubscription({
          db,
          shopId,
          planId,
          billingCycle,
          paymentTxnId: eventId
        });
        request.log.info({ shopId, planId, billingCycle, eventId }, 'Vendor subscription upgraded via PayU webhook');
        return reply.code(200).send({ status: 'SUBSCRIPTION_UPGRADED', shopId, planId });
      }
    }

    // 3. Locate customer order in database
    const order = await db.collection<OrderDocument>('orders').findOne({ orderId: txnid });
    if (!order) {
      request.log.warn({ txnid }, 'PayU webhook received for unknown order — acknowledged and ignored');
      return reply.code(200).send({ status: 'IGNORED', reason: 'order_not_found' });
    }

    // 4. Handle REFUND Event
    if (isRefund) {
      const now = new Date();
      const refundAmountPaise = Math.round(Number(payload.amount || payload.refund_amount || 0) * 100);

      await db.collection<OrderDocument>('orders').updateOne(
        { orderId: order.orderId },
        {
          $set: { status: 'REFUND_PENDING', updatedAt: now },
          $push: {
            auditTrail: {
              actor: 'payu',
              from: order.status,
              to: 'REFUND_PENDING',
              opId: eventId,
              reason: `PayU refund processed (refundId: ${payload.refund_id || payload.refundId || eventId})`,
              time: now
            }
          }
        }
      );

      // Cancel the print job if it is still queued to prevent unnecessary printing
      const job = await db.collection<JobDocument>('jobs').findOne({ orderId: order.orderId });
      if (job && ['QUEUED', 'UPLOADED'].includes(job.status)) {
        await transitionJobState({
          db,
          jobId: job.jobId,
          expectedState: job.status,
          targetState: 'CANCELLED',
          actor: 'payu',
          reason: 'Print cancelled due to customer refund'
        });
      }

      await db.collection<PaymentDocument>('payments').insertOne({
        _id: new ObjectId(),
        orderId: order.orderId,
        shopId: order.shopId,
        provider: 'payu',
        providerOrderId: txnid,
        providerPaymentId: eventId,
        providerEventId: eventId,
        amountPaise: refundAmountPaise || order.pricing.amountPaise,
        currency: 'INR',
        status: 'FAILED', // marks transaction reversal in payments
        rawPayload: payload,
        createdAt: now
      });

      request.log.info({ txnid, refundAmountPaise }, 'PayU refund processed and recorded');
      return reply.code(200).send({ status: 'REFUND_RECORDED', txnid });
    }

    // 4. Handle PAYMENT FAILED Event
    if (!isSuccess) {
      const now = new Date();
      await db.collection<OrderDocument>('orders').updateOne(
        { orderId: order.orderId, status: 'PAYMENT_PENDING' },
        {
          $set: { status: 'FAILED', updatedAt: now },
          $push: {
            auditTrail: {
              actor: 'payu',
              from: order.status,
              to: 'FAILED',
              opId: eventId,
              reason: `PayU payment status: ${status} (${payload.error_Message || payload.unmappedstatus || 'failed'})`,
              time: now
            }
          }
        }
      );

      await db.collection<PaymentDocument>('payments').insertOne({
        _id: new ObjectId(),
        orderId: order.orderId,
        shopId: order.shopId,
        provider: 'payu',
        providerOrderId: txnid,
        providerPaymentId: eventId,
        providerEventId: eventId,
        amountPaise: Math.round(Number(payload.amount || 0) * 100),
        currency: 'INR',
        status: 'FAILED',
        rawPayload: payload,
        createdAt: now
      });

      return reply.code(200).send({ status: 'FAILED_RECORDED' });
    }

    // 5. Handle PAYMENT SUCCESS Event: Fulfill order & send to printer
    const fulfillResult = await fulfillPaidOrder({
      db,
      orderId: order.orderId,
      providerPaymentId: eventId,
      providerEventId: eventId,
      provider: 'payu',
      rawPayload: payload,
      wsHub,
      reason: 'Verified PayU webhook notification received'
    });

    request.log.info({ txnid, jobId: fulfillResult.jobId }, 'PayU order fulfilled via webhook');
    return reply.code(200).send({ status: 'SUCCESS_PROCESSED', jobId: fulfillResult.jobId });
  });

  // ── PayU Browser SURL / FURL Return Endpoint ───────────────────────────────
  fastify.post('/payu/response', async (request, reply) => {
    const payload = (request.body as any) || {};
    const query = request.query as Record<string, string | undefined>;
    const shopSlug = (payload.udf1 || query.shop || 'default').trim();
    const txnid = String(payload.txnid || '').trim();
    const status = String(payload.status || '').toLowerCase();
    const receivedHash = String(payload.hash || '').trim();

    const creds = getPayUCredentials();
    const isValid = verifyPayUResponseHash({
      receivedHash,
      status,
      txnid,
      amount: String(payload.amount || ''),
      productinfo: String(payload.productinfo || ''),
      firstname: String(payload.firstname || ''),
      email: String(payload.email || ''),
      key: String(payload.key || creds.merchantKey),
      salt: creds.merchantSalt,
      udf1: payload.udf1,
      udf2: payload.udf2,
      udf3: payload.udf3,
      udf4: payload.udf4,
      udf5: payload.udf5,
      additionalCharges: payload.additionalCharges
    });

    if (isValid && status === 'success' && txnid) {
      const eventId = String(payload.payuid || payload.mihpayid || `payu_${Date.now()}`);

      // Vendor Subscription Upgrade redirect
      if (payload.udf2 === 'SUBSCRIPTION_UPGRADE') {
        const shopId = payload.udf5;
        const planId = (payload.udf3 || 'STARTER').toUpperCase() as any;
        const billingCycle = (payload.udf4 || 'monthly').toLowerCase() as any;
        if (shopId && ObjectId.isValid(shopId)) {
          await upgradeShopSubscription({
            db,
            shopId,
            planId,
            billingCycle,
            paymentTxnId: eventId
          });
        }
        return reply.redirect(`/vendor?upgrade=success&plan=${encodeURIComponent(planId)}`);
      }

      await fulfillPaidOrder({
        db,
        orderId: txnid,
        providerPaymentId: eventId,
        providerEventId: eventId,
        provider: 'payu',
        rawPayload: payload,
        wsHub,
        reason: 'Verified PayU customer checkout redirect'
      });
      return reply.redirect(`/shop/${shopSlug}?order_id=${encodeURIComponent(txnid)}&payment=success`);
    } else {
      if (payload.udf2 === 'SUBSCRIPTION_UPGRADE') {
        return reply.redirect(`/vendor?upgrade=failed`);
      }
      return reply.redirect(`/shop/${shopSlug}?order_id=${encodeURIComponent(txnid)}&payment=failed`);
    }
  });

  // Also support GET /payu/response in case of GET redirect
  fastify.get('/payu/response', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const shopSlug = (query.shop || 'default').trim();
    const orderId = query.order_id || query.txnid || '';
    const status = (query.status || '').toLowerCase();
    if (status === 'success' && orderId) {
      return reply.redirect(`/shop/${shopSlug}?order_id=${encodeURIComponent(orderId)}&payment=success`);
    }
    return reply.redirect(`/shop/${shopSlug}?order_id=${encodeURIComponent(orderId)}&payment=failed`);
  });
};
