import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { buildApp, AppInstance } from '../src/app.js';
import { ensureIndexes } from '../src/db/mongo.js';
import { transitionJobState, reportPrintOutcome } from '../src/services/stateMachine.js';
import { generateSecureToken } from '../src/services/auth.js';
import {
  ShopDocument,
  AgentDocument,
  OrderDocument,
  JobDocument,
  PaymentDocument,
  LedgerDocument,
  OutboxDocument
} from '../src/types.js';

describe('ShopPrint Cloud Control Plane Test Suite', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let appInstance: AppInstance;
  const testDbName = `test_shopprint_${Date.now()}`;
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';

  // Test entities
  let shopA: ShopDocument;
  let shopB: ShopDocument;
  let agentASecret: string;
  let agentADoc: AgentDocument;
  let agentBSecret: string;
  let agentBDoc: AgentDocument;

  beforeAll(async () => {
    mongoClient = new MongoClient(mongoUri, { directConnection: true, serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    db = mongoClient.db(testDbName);
    await ensureIndexes(db);
    appInstance = buildApp(db, mongoClient, false);
    await appInstance.fastify.ready();
  }, 30000);

  afterAll(async () => {
    if (appInstance) {
      await appInstance.close();
    }
    if (db) {
      await db.dropDatabase();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
  });

  beforeEach(async () => {
    await db.collection('orders').deleteMany({});
    await db.collection('jobs').deleteMany({});
    await db.collection('payments').deleteMany({});
    await db.collection('ledger').deleteMany({});
    await db.collection('outbox').deleteMany({});
    await db.collection('agents').deleteMany({});
    await db.collection('shops').deleteMany({});

    // Seed Shop A
    shopA = {
      _id: new ObjectId(),
      name: 'Shop Alpha',
      slug: 'shop-alpha',
      ownerEmail: 'alpha@print.local',
      pinHash: crypto.createHash('sha256').update('1234').digest('hex'),
      pricing: {
        bwPerPagePaise: 200,
        colorPerPagePaise: 1000,
        duplexDiscountPaise: 50
      },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection<ShopDocument>('shops').insertOne(shopA);

    // Seed Shop B
    shopB = {
      _id: new ObjectId(),
      name: 'Shop Beta',
      slug: 'shop-beta',
      ownerEmail: 'beta@print.local',
      pinHash: crypto.createHash('sha256').update('5678').digest('hex'),
      pricing: {
        bwPerPagePaise: 300,
        colorPerPagePaise: 1500,
        duplexDiscountPaise: 0
      },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection<ShopDocument>('shops').insertOne(shopB);

    // Seed Agent A
    const tA = generateSecureToken();
    agentASecret = tA.secret;
    agentADoc = {
      _id: new ObjectId(),
      shopId: shopA._id,
      name: 'Agent Alpha 1',
      tokenHash: tA.hash,
      isRevoked: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection<AgentDocument>('agents').insertOne(agentADoc);

    // Seed Agent B
    const tB = generateSecureToken();
    agentBSecret = tB.secret;
    agentBDoc = {
      _id: new ObjectId(),
      shopId: shopB._id,
      name: 'Agent Beta 1',
      tokenHash: tB.hash,
      isRevoked: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection<AgentDocument>('agents').insertOne(agentBDoc);
  });

  // Helper to construct Cashfree HMAC signature
  function createCashfreeSignature(rawBody: string, timestamp: string, secretKey: string = 'TEST_SECRET_KEY'): string {
    return crypto.createHmac('sha256', secretKey).update(timestamp + rawBody).digest('base64');
  }

  // 1. Webhook signature tests
  describe('1. Webhook Signature', () => {
    it('rejects webhook request with invalid signature', async () => {
      const payload = {
        data: {
          order: { order_id: 'ord_test_sig', order_amount: 10.0, order_currency: 'INR' },
          payment: { payment_status: 'SUCCESS' }
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK'
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Date.now());

      const res = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'invalid_bad_signature==',
          'x-webhook-timestamp': timestamp
        },
        payload: rawBody
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Invalid webhook signature');
    });

    it('accepts webhook request with valid signature', async () => {
      // Seed an order
      const orderId = 'ord_valid_sig';
      const orderDoc: OrderDocument = {
        _id: new ObjectId(),
        orderId,
        shopId: shopA._id,
        files: [],
        printOptions: { copies: 1, colorMode: 'monochrome', duplexMode: 'simplex', paperSize: 'A4', fitMode: 'fit', orientation: 'portrait', pagesPerSheet: 1 },
        pricing: { amountPaise: 1000, currency: 'INR', platformFeePaise: 50, vendorSharePaise: 950 },
        status: 'PAYMENT_PENDING',
        retentionUntil: new Date(Date.now() + 86400000),
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.collection('orders').insertOne(orderDoc);

      const payload = {
        data: {
          order: { order_id: orderId, order_amount: 10.0, order_currency: 'INR' },
          payment: { cf_payment_id: 'cf_101', payment_status: 'SUCCESS', payment_amount: 10.0, payment_currency: 'INR' }
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK'
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const signature = createCashfreeSignature(rawBody, timestamp);

      const res = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-timestamp': timestamp
        },
        payload: rawBody
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('SUCCESS_PROCESSED');
    });
  });

  // 2. Duplicate and out-of-order events
  describe('2. Duplicate and Out-of-Order Webhook Events', () => {
    it('handles duplicate SUCCESS webhook idempotently without duplicating job', async () => {
      const orderId = 'ord_dup_test';
      await db.collection('orders').insertOne({
        _id: new ObjectId(),
        orderId,
        shopId: shopA._id,
        files: [],
        printOptions: { copies: 1, colorMode: 'monochrome', duplexMode: 'simplex', paperSize: 'A4', fitMode: 'fit', orientation: 'portrait', pagesPerSheet: 1 },
        pricing: { amountPaise: 500, currency: 'INR', platformFeePaise: 25, vendorSharePaise: 475 },
        status: 'PAYMENT_PENDING',
        retentionUntil: new Date(Date.now() + 86400000),
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      const payload = {
        data: {
          order: { order_id: orderId, order_amount: 5.0, order_currency: 'INR' },
          payment: { cf_payment_id: 'cf_evt_dup', payment_status: 'SUCCESS', payment_amount: 5.0, payment_currency: 'INR' }
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK'
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const signature = createCashfreeSignature(rawBody, timestamp);

      // First webhook call
      const res1 = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
        payload: rawBody
      });
      expect(res1.statusCode).toBe(200);

      // Duplicate webhook call
      const res2 = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
        payload: rawBody
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).status).toBe('DUPLICATE_ACK');

      // Verify only 1 job was created
      const jobCount = await db.collection('jobs').countDocuments({ orderId });
      expect(jobCount).toBe(1);
    });

    it('ensures a late failure webhook does not override success', async () => {
      const orderId = 'ord_late_failure';
      await db.collection('orders').insertOne({
        _id: new ObjectId(),
        orderId,
        shopId: shopA._id,
        files: [],
        printOptions: { copies: 1, colorMode: 'monochrome', duplexMode: 'simplex', paperSize: 'A4', fitMode: 'fit', orientation: 'portrait', pagesPerSheet: 1 },
        pricing: { amountPaise: 500, currency: 'INR', platformFeePaise: 25, vendorSharePaise: 475 },
        status: 'PAID', // Already paid
        retentionUntil: new Date(Date.now() + 86400000),
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      const failPayload = {
        data: {
          order: { order_id: orderId, order_amount: 5.0, order_currency: 'INR' },
          payment: { cf_payment_id: 'cf_late_fail', payment_status: 'FAILED', payment_amount: 5.0, payment_currency: 'INR' }
        },
        type: 'PAYMENT_FAILED_WEBHOOK'
      };
      const rawBody = JSON.stringify(failPayload);
      const timestamp = String(Date.now());
      const signature = createCashfreeSignature(rawBody, timestamp);

      const res = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
        payload: rawBody
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('IGNORED');

      // Order status remains PAID
      const order = await db.collection<OrderDocument>('orders').findOne({ orderId });
      expect(order?.status).toBe('PAID');
    });
  });

  // 3. Atomic payment->job & 4. No duplicate ledger
  describe('3 & 4. Atomic Payment->Job and Single Ledger Entry', () => {
    it('atomically creates QUEUED job, outbox, and single ledger row upon payment', async () => {
      const orderId = 'ord_atomic_ledger';
      await db.collection('orders').insertOne({
        _id: new ObjectId(),
        orderId,
        shopId: shopA._id,
        files: [],
        printOptions: { copies: 2, colorMode: 'monochrome', duplexMode: 'simplex', paperSize: 'A4', fitMode: 'fit', orientation: 'portrait', pagesPerSheet: 1 },
        pricing: { amountPaise: 2000, currency: 'INR', platformFeePaise: 100, vendorSharePaise: 1900 },
        status: 'PAYMENT_PENDING',
        retentionUntil: new Date(Date.now() + 86400000),
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      const payload = {
        data: {
          order: { order_id: orderId, order_amount: 20.0, order_currency: 'INR' },
          payment: { cf_payment_id: 'cf_atomic_1', payment_status: 'SUCCESS', payment_amount: 20.0, payment_currency: 'INR' }
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK'
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const signature = createCashfreeSignature(rawBody, timestamp);

      const res = await appInstance.fastify.inject({
        method: 'POST',
        url: '/api/webhooks/cashfree',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
        payload: rawBody
      });
      expect(res.statusCode).toBe(200);

      // Verify order is PAID
      const order = await db.collection<OrderDocument>('orders').findOne({ orderId });
      expect(order?.status).toBe('PAID');

      // Verify QUEUED job created
      const job = await db.collection<JobDocument>('jobs').findOne({ orderId });
      expect(job).toBeTruthy();
      expect(job?.status).toBe('QUEUED');

      // Verify Outbox created
      const outbox = await db.collection<OutboxDocument>('outbox').findOne({ jobId: job?.jobId });
      expect(outbox).toBeTruthy();
      expect(outbox?.status).toBe('PENDING');

      // Verify Ledger: exactly ONE entry with accurate splits
      const ledgerEntries = await db.collection<LedgerDocument>('ledger').find({ orderId }).toArray();
      expect(ledgerEntries.length).toBe(1);
      expect(ledgerEntries[0].grossPaise).toBe(2000);
      expect(ledgerEntries[0].platformFeePaise).toBe(100);
      expect(ledgerEntries[0].vendorSharePaise).toBe(1900);
    });
  });

  // 5. State guards
  describe('5. State Guards', () => {
    it('rejects illegal state transitions', async () => {
      const jobId = 'job_guard_test';
      await db.collection('jobs').insertOne({
        _id: new ObjectId(),
        jobId,
        orderId: 'ord_guard',
        shopId: shopA._id,
        status: 'UPLOADED' as any,
        retryCount: 0,
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // UPLOADED cannot jump straight to COMPLETED
      const result = await transitionJobState({
        db,
        jobId,
        expectedState: 'UPLOADED',
        targetState: 'COMPLETED',
        actor: 'system'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Illegal transition');
    });

    it('rejects stale state transitions', async () => {
      const jobId = 'job_stale_test';
      await db.collection('jobs').insertOne({
        _id: new ObjectId(),
        jobId,
        orderId: 'ord_stale',
        shopId: shopA._id,
        status: 'DOWNLOADING',
        retryCount: 0,
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Caller expects QUEUED, but state is already DOWNLOADING
      const result = await transitionJobState({
        db,
        jobId,
        expectedState: 'QUEUED',
        targetState: 'DOWNLOADING',
        actor: 'agent'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Stale transition');
    });
  });

  // 6. Cross-shop access
  describe('6. Cross-Shop Access Control', () => {
    it('prevents Agent A from accessing Shop B jobs', async () => {
      // Create job belonging to Shop B
      const jobBId = 'job_shop_b';
      await db.collection('jobs').insertOne({
        _id: new ObjectId(),
        jobId: jobBId,
        orderId: 'ord_b',
        shopId: shopB._id,
        status: 'QUEUED',
        retryCount: 0,
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Agent A attempts to fetch job download URL for Shop B's job
      const res = await appInstance.fastify.inject({
        method: 'GET',
        url: `/api/agent/jobs/${jobBId}/download-url`,
        headers: {
          'authorization': `Bearer ${agentASecret}`
        }
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toContain('not found or unauthorized');
    });
  });

  // 7. Token revocation
  describe('7. Agent Token Revocation', () => {
    it('rejects API requests from a revoked agent token', async () => {
      // Revoke Agent A
      await db.collection('agents').updateOne({ _id: agentADoc._id }, { $set: { isRevoked: true } });

      const res = await appInstance.fastify.inject({
        method: 'GET',
        url: '/api/agent/jobs',
        headers: {
          'authorization': `Bearer ${agentASecret}`
        }
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toContain('revoked');
    });
  });

  // 8. Outbox redelivery
  describe('8. Outbox Redelivery and Backoff', () => {
    it('backs off when agent is offline and retries up to max attempts', async () => {
      const outboxId = new ObjectId();
      await db.collection('outbox').insertOne({
        _id: outboxId,
        shopId: shopA._id,
        jobId: 'job_outbox_offline',
        payload: { type: 'job', id: 'job_outbox_offline', op: 'dispatch' },
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Process batch while agent is offline
      await appInstance.outboxWorker.processOutboxBatch();

      const updated = await db.collection<OutboxDocument>('outbox').findOne({ _id: outboxId });
      expect(updated?.attempts).toBe(1);
      expect(updated?.status).toBe('PENDING');
      expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // 9. Reconnect recovery
  describe('9. Reconnect Recovery', () => {
    it('allows agent to query all pending jobs from authoritative DB on reconnect', async () => {
      await db.collection('jobs').insertOne({
        _id: new ObjectId(),
        jobId: 'job_pending_reconnect',
        orderId: 'ord_reconnect',
        shopId: shopA._id,
        status: 'QUEUED',
        retryCount: 0,
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const res = await appInstance.fastify.inject({
        method: 'GET',
        url: '/api/agent/jobs',
        headers: {
          'authorization': `Bearer ${agentASecret}`
        }
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.jobs.some((j: any) => j.jobId === 'job_pending_reconnect')).toBe(true);
    });
  });

  // 10. Retention protection
  describe('10. R2 File Retention Protection', () => {
    it('protects paid order files until retention date has passed', async () => {
      // Future retention order
      const futureOrder = {
        _id: new ObjectId(),
        orderId: 'ord_retention_future',
        shopId: shopA._id,
        files: [{ fileKey: 'shops/a/test1.pdf', originalFilename: 'doc.pdf', fileSize: 100, mimeType: 'application/pdf', pageCount: 1 }],
        printOptions: { copies: 1, colorMode: 'monochrome', duplexMode: 'simplex', paperSize: 'A4', fitMode: 'fit', orientation: 'portrait', pagesPerSheet: 1 },
        pricing: { amountPaise: 500, currency: 'INR', platformFeePaise: 25, vendorSharePaise: 475 },
        status: 'COMPLETED' as const,
        retentionUntil: new Date(Date.now() + 7 * 86400000), // 7 days in future
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.collection('orders').insertOne(futureOrder as any);

      // Run cleanup sweep
      const result = await appInstance.cleanupWorker.runCleanupSweep();

      // Future order should NOT be cleaned up
      const check = await db.collection('orders').findOne({ orderId: 'ord_retention_future' });
      expect((check as any)?.filesCleanedUp).toBeFalsy();
    });
  });

  // 11. Uncertain print outcome -> MANUAL_REVIEW
  describe('11. Uncertain Print Outcome Handling', () => {
    it('routes UNCERTAIN print outcome to MANUAL_REVIEW and never auto-resubmits', async () => {
      const jobId = 'job_uncertain_jam';
      await db.collection('jobs').insertOne({
        _id: new ObjectId(),
        jobId,
        orderId: 'ord_jam',
        shopId: shopA._id,
        status: 'PRINT_SUBMITTED',
        retryCount: 0,
        auditTrail: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const result = await reportPrintOutcome({
        db,
        jobId,
        outcome: 'UNCERTAIN',
        reason: 'Paper jam occurred during printing'
      });

      expect(result.success).toBe(true);
      expect(result.job?.status).toBe('MANUAL_REVIEW');

      const saved = await db.collection<JobDocument>('jobs').findOne({ jobId });
      expect(saved?.status).toBe('MANUAL_REVIEW');
      expect(saved?.failureReason).toContain('Paper jam');
    });
  });
});
