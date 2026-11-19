import { Db, ObjectId } from 'mongodb';
import { OrderDocument, JobDocument, PaymentDocument, OutboxDocument, LedgerDocument } from '../types.js';
import { WebSocketHub } from './wsHub.js';
import { outboxBus } from './outboxWorker.js';

export async function fulfillPaidOrder(params: {
  db: Db;
  orderId: string;
  providerPaymentId?: string;
  providerEventId?: string;
  provider?: 'cashfree' | 'payu';
  rawPayload?: any;
  wsHub?: WebSocketHub;
  reason?: string;
}): Promise<{ success: boolean; jobId?: string; alreadyFulfilled?: boolean; error?: string }> {
  const { db, orderId, providerPaymentId, providerEventId, rawPayload, wsHub, reason } = params;
  const provider = params.provider || (params.rawPayload?.payuid ? 'payu' : 'cashfree');
  const now = new Date();

  const order = await db.collection<OrderDocument>('orders').findOne({ orderId });
  if (!order) {
    return { success: false, error: `Order ${orderId} not found` };
  }

  const isAlreadyPaidOrBeyond = [
    'PAID',
    'QUEUED',
    'DOWNLOADING',
    'PRINT_SUBMITTED',
    'COMPLETED',
    'MANUAL_REVIEW'
  ].includes(order.status);

  const jobId = `job_${order.orderId}`;

  if (isAlreadyPaidOrBeyond) {
    if (wsHub) {
      wsHub.sendJobHint(order.shopId.toString(), jobId);
    }
    return { success: true, jobId, alreadyFulfilled: true };
  }

  const eventId = providerEventId || `evt_${Date.now()}`;

  // 1. Conditionally mark order PAID
  const orderUpdate = await db.collection<OrderDocument>('orders').findOneAndUpdate(
    { orderId: order.orderId, status: 'PAYMENT_PENDING' },
    {
      $set: { status: 'PAID', updatedAt: now },
      $push: {
        auditTrail: {
          actor: provider,
          from: 'PAYMENT_PENDING',
          to: 'PAID',
          opId: eventId,
          reason: reason || `Verified ${provider} payment received`,
          time: now
        }
      }
    },
    { returnDocument: 'after' }
  );

  if (!orderUpdate) {
    return { success: true, jobId, alreadyFulfilled: true };
  }

  // 2. Record payment document (idempotent: skip if same providerEventId already exists)
  const existingPayment = await db.collection<PaymentDocument>('payments').findOne({ providerEventId: eventId });
  if (!existingPayment) {
    await db.collection<PaymentDocument>('payments').insertOne({
      _id: new ObjectId(),
      orderId: order.orderId,
      shopId: order.shopId,
      provider,
      providerOrderId: order.providerOrderId || order.orderId,
      providerPaymentId: providerPaymentId || `${provider}_pay_${Date.now()}`,
      providerEventId: eventId,
      amountPaise: order.pricing.amountPaise,
      currency: 'INR',
      status: 'SUCCESS',
      rawPayload: rawPayload || { simulated: true },
      createdAt: now
    });
  }

  // 3. Create QUEUED job document
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
        reason: 'Payment confirmed, queued for printing'
      }
    ],
    createdAt: now,
    updatedAt: now
  };
  await db.collection<JobDocument>('jobs').insertOne(jobDoc);

  // 4. Insert outbox entry
  await db.collection<OutboxDocument>('outbox').insertOne({
    _id: new ObjectId(),
    jobId,
    shopId: order.shopId,
    payload: {
      type: 'job',
      id: jobId,
      op: 'PRINT_JOB'
    },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now
  });

  // ── Instant wake-up: kick the outbox worker now instead of waiting for poll ──
  // This drops payment → vendor WS dispatch latency from ~1,000ms to ~15ms.
  outboxBus.emit('outbox:new');

  // 5. Append ledger entry (gross, platform fee, vendor share)
  await db.collection<LedgerDocument>('ledger').insertOne({
    _id: new ObjectId(),
    orderId: order.orderId,
    shopId: order.shopId,
    grossPaise: order.pricing.amountPaise,
    platformFeePaise: order.pricing.platformFeePaise,
    vendorSharePaise: order.pricing.vendorSharePaise,
    currency: 'INR',
    settled: false,
    createdAt: now
  });

  // 6. Send instant WebSocket hint to Windows print station
  if (wsHub) {
    wsHub.sendJobHint(order.shopId.toString(), jobId);
  }

  return { success: true, jobId };
}
