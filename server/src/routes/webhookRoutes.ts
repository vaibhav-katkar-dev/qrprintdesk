import { FastifyPluginAsync } from 'fastify';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { verifyCashfreeWebhook } from '../services/cashfree.js';
import { fulfillPaidOrder } from '../services/paymentFulfillment.js';
import { WebSocketHub } from '../services/wsHub.js';
import { OrderDocument, PaymentDocument, ShopDocument } from '../types.js';

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
};
