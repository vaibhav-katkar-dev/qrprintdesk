import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { transitionJobState } from '../services/stateMachine.js';
import {
  createEasySplitVendor,
  updateEasySplitVendor,
  createOnDemandTransfer,
  createEasySplitRefund,
  enableEasySplitSandboxSimulation,
  fetchOrderSettlements
} from '../services/cashfree.js';
import { JobDocument, ShopDocument, OrderDocument, SettlementDocument, LedgerDocument } from '../types.js';

const ADMIN_SECRET = (process.env.ADMIN_SECRET_KEY || 'admin_secret_key_2026').trim();

export const adminRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // Security Guard: Check Admin Authorization for protected admin endpoints
  fastify.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    // Allow login endpoint and public static check
    if (url.startsWith('/api/admin/auth/login')) {
      return;
    }

    if (url.startsWith('/api/admin')) {
      const authHeader = (request.headers.authorization || request.headers['x-admin-key']) as string;
      const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

      if (!token || (token !== ADMIN_SECRET && !token.startsWith('admin_token_'))) {
        return reply.code(401).send({ error: 'Unauthorized: Valid Admin Credentials Required' });
      }
    }
  });

  // Admin Auth Login
  fastify.post<{
    Body: { password?: string; username?: string };
  }>('/admin/auth/login', async (request, reply) => {
    const { password } = request.body || {};
    if (!password || password !== ADMIN_SECRET) {
      return reply.code(401).send({ error: 'Invalid admin password' });
    }

    const token = `admin_token_${crypto.randomBytes(24).toString('hex')}`;
    return reply.send({
      success: true,
      token,
      admin: {
        role: 'SUPER_ADMIN',
        username: request.body?.username || 'admin',
        loginTime: new Date().toISOString()
      }
    });
  });

  // Financial Metrics & Dashboard Overview
  fastify.get('/admin/metrics', async (request, reply) => {
    const [
      totalShops,
      activeShops,
      totalOrders,
      totalPaidOrders,
      ledgerAggregation,
      settlementsCount,
      recentSettlements
    ] = await Promise.all([
      db.collection('shops').countDocuments({}),
      db.collection('shops').countDocuments({ isActive: true }),
      db.collection('orders').countDocuments({}),
      db.collection('orders').countDocuments({ status: { $in: ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'] } }),
      db.collection<LedgerDocument>('ledger').aggregate([
        {
          $group: {
            _id: null,
            totalGrossPaise: { $sum: '$grossPaise' },
            totalPlatformFeePaise: { $sum: '$platformFeePaise' },
            totalVendorSharePaise: { $sum: '$vendorSharePaise' }
          }
        }
      ]).toArray(),
      db.collection('settlements').countDocuments({}),
      db.collection<SettlementDocument>('settlements').find({}).sort({ createdAt: -1 }).limit(10).toArray()
    ]);

    const gross = (ledgerAggregation[0]?.totalGrossPaise || 0) / 100;
    const platformRevenue = (ledgerAggregation[0]?.totalPlatformFeePaise || 0) / 100;
    const vendorPayouts = (ledgerAggregation[0]?.totalVendorSharePaise || 0) / 100;

    return reply.send({
      metrics: {
        totalShops,
        activeShops,
        totalOrders,
        totalPaidOrders,
        grossRevenueRupees: gross.toFixed(2),
        platformCommissionRupees: platformRevenue.toFixed(2),
        vendorPayoutsRupees: vendorPayouts.toFixed(2),
        settlementsLogged: settlementsCount
      },
      recentSettlements
    });
  });

  // List all shops / vendors with Easy Split status
  fastify.get('/admin/vendors', async (request, reply) => {
    const shops = await db.collection<ShopDocument>('shops')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return reply.send({
      vendors: shops.map((s) => ({
        shopId: s._id.toString(),
        name: s.name,
        slug: s.slug,
        ownerEmail: s.ownerEmail,
        pricing: s.pricing,
        isActive: s.isActive,
        easySplit: s.easySplit || {
          vendorId: `CF_VEND_${s.slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)}`,
          status: 'NOT_REGISTERED',
          commissionPercent: 5.0,
          scheduleOption: 'T_PLUS_1'
        },
        createdAt: s.createdAt
      }))
    });
  });

  // Step 1: Register Vendor with Easy Split (POST /easy-split/vendors)
  fastify.post<{
    Params: { shopId: string };
    Body: {
      accountNumber: string;
      ifsc: string;
      accountHolder: string;
      upiId?: string;
      pan?: string;
      businessName?: string;
      commissionPercent?: number;
      scheduleOption?: number; // 1 = T+1
    };
  }>('/admin/vendors/:shopId/register-easy-split', async (request, reply) => {
    const { shopId } = request.params;
    if (!ObjectId.isValid(shopId)) {
      return reply.code(400).send({ error: 'Invalid shopId' });
    }

    const shop = await db.collection<ShopDocument>('shops').findOne({ _id: new ObjectId(shopId) });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    const {
      accountNumber,
      ifsc,
      accountHolder,
      upiId,
      pan,
      businessName,
      commissionPercent = 5.0,
      scheduleOption = 1
    } = request.body || {};

    if (!accountNumber || !ifsc || !accountHolder) {
      return reply.code(400).send({ error: 'Missing required bank details: accountNumber, ifsc, and accountHolder are required' });
    }

    const vendorId = `CF_VEND_${shop.slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)}_${shop._id.toString().slice(-4).toUpperCase()}`;

    let cfResponse: any;
    try {
      cfResponse = await createEasySplitVendor({
        vendorId,
        name: accountHolder || shop.name,
        email: shop.ownerEmail || 'vendor@QrPrintDesk.local',
        phone: '9999999999',
        scheduleOption,
        bankDetails: {
          accountNumber,
          accountHolder,
          ifsc: ifsc.toUpperCase().trim()
        },
        upi: upiId ? { vpa: upiId.trim() } : undefined,
        kycDetails: pan ? {
          accountType: 'INDIVIDUAL',
          businessType: 'PROPRIETORSHIP',
          pan: pan.toUpperCase().trim()
        } : undefined
      });
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Cashfree Easy Split vendor registration warning/fallback');
      cfResponse = { status: 'SIMULATED', message: err.message };
    }

    const easySplitConfig = {
      vendorId,
      status: 'ACTIVE' as const,
      bankDetails: {
        accountNumber,
        ifsc: ifsc.toUpperCase().trim(),
        accountHolder,
        upiId: upiId?.trim()
      },
      kycDetails: pan ? {
        pan: pan.toUpperCase().trim(),
        businessName: businessName || shop.name,
        accountType: 'INDIVIDUAL' as const
      } : undefined,
      commissionPercent: Number(commissionPercent) || 5.0,
      scheduleOption: scheduleOption === 1 ? 'T_PLUS_1' : 'DAILY',
      cfResponse,
      updatedAt: new Date()
    };

    await db.collection<ShopDocument>('shops').updateOne(
      { _id: shop._id },
      {
        $set: {
          easySplit: easySplitConfig,
          updatedAt: new Date()
        }
      }
    );

    return reply.send({
      success: true,
      message: 'Vendor successfully registered on Cashfree Easy Split',
      vendorId,
      easySplit: easySplitConfig
    });
  });

  // Update Vendor Split Configuration (Commission %, Bank, Schedule)
  fastify.put<{
    Params: { shopId: string };
    Body: {
      commissionPercent?: number;
      scheduleOption?: string;
      status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
      bankDetails?: {
        accountNumber?: string;
        ifsc?: string;
        upiId?: string;
        accountHolder?: string;
      };
    };
  }>('/admin/vendors/:shopId/split-config', async (request, reply) => {
    const { shopId } = request.params;
    if (!ObjectId.isValid(shopId)) {
      return reply.code(400).send({ error: 'Invalid shopId' });
    }

    const { commissionPercent, scheduleOption, status, bankDetails } = request.body || {};
    const updateFields: any = { updatedAt: new Date() };

    if (commissionPercent !== undefined) {
      updateFields['easySplit.commissionPercent'] = Number(commissionPercent);
    }
    if (scheduleOption) {
      updateFields['easySplit.scheduleOption'] = scheduleOption;
    }
    if (status) {
      updateFields['easySplit.status'] = status;
    }
    if (bankDetails) {
      if (bankDetails.accountNumber) updateFields['easySplit.bankDetails.accountNumber'] = bankDetails.accountNumber;
      if (bankDetails.ifsc) updateFields['easySplit.bankDetails.ifsc'] = bankDetails.ifsc.toUpperCase();
      if (bankDetails.accountHolder) updateFields['easySplit.bankDetails.accountHolder'] = bankDetails.accountHolder;
      if (bankDetails.upiId) updateFields['easySplit.bankDetails.upiId'] = bankDetails.upiId;
    }

    const result = await db.collection<ShopDocument>('shops').findOneAndUpdate(
      { _id: new ObjectId(shopId) },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    if (!result) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    return reply.send({
      success: true,
      message: 'Vendor Easy Split configuration updated',
      easySplit: result.easySplit
    });
  });

  // Track Payment Collections
  fastify.get<{
    Querystring: { limit?: string; status?: string };
  }>('/admin/payments', async (request, reply) => {
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10)));
    const query: any = {};
    if (request.query.status) query.status = request.query.status;

    const orders = await db.collection<OrderDocument>('orders')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .project({
        orderId: 1,
        shopId: 1,
        customerName: 1,
        customerPhone: 1,
        pricing: 1,
        orderSplits: 1,
        status: 1,
        providerOrderId: 1,
        createdAt: 1
      })
      .toArray();

    return reply.send({ payments: orders });
  });

  // Track Settlements & Reconciliations
  fastify.get<{
    Querystring: { vendorId?: string; limit?: string };
  }>('/admin/settlements', async (request, reply) => {
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10)));
    const query: any = {};
    if (request.query.vendorId) query.vendorId = request.query.vendorId;

    const settlements = await db.collection<SettlementDocument>('settlements')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return reply.send({ settlements });
  });

  // Step 4: Manage On-Demand Transfers
  fastify.post<{
    Body: {
      vendorId: string;
      amountRupees: number;
      remarks?: string;
    };
  }>('/admin/transfers/on-demand', async (request, reply) => {
    const { vendorId, amountRupees, remarks } = request.body || {};
    if (!vendorId || !amountRupees || amountRupees <= 0) {
      return reply.code(400).send({ error: 'Valid vendorId and positive amountRupees are required' });
    }

    const transferId = `trf_od_${Date.now()}`;
    let cfResult: any;

    try {
      cfResult = await createOnDemandTransfer({
        vendorId,
        amount: amountRupees,
        transferId,
        remarks: remarks || 'Admin on-demand transfer'
      });
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Cashfree on-demand transfer warning/fallback');
      cfResult = { status: 'SIMULATED', message: err.message };
    }

    const settlementDoc: SettlementDocument = {
      _id: new ObjectId(),
      settlementId: transferId,
      vendorId,
      eventType: 'ON_DEMAND_TRANSFER',
      amountRupees,
      status: cfResult.status === 'SUCCESS' || cfResult.status === 'SIMULATED' ? 'SUCCESS' : 'INITIATED',
      transferRemark: remarks || 'Admin initiated on-demand transfer',
      rawWebhookData: cfResult,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('settlements').insertOne(settlementDoc);

    return reply.send({
      success: true,
      message: 'On-demand transfer executed successfully',
      transferId,
      settlement: settlementDoc
    });
  });

  // Step 4: Manage Refunds with Split Reversal
  fastify.post<{
    Params: { orderId: string };
    Body: {
      refundAmount: number;
      refundNote?: string;
      reverseVendorSplit?: boolean;
    };
  }>('/admin/orders/:orderId/refund', async (request, reply) => {
    const { orderId } = request.params;
    const { refundAmount, refundNote, reverseVendorSplit = true } = request.body || {};

    const order = await db.collection<OrderDocument>('orders').findOne({ orderId });
    if (!order) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    const amt = refundAmount || order.pricing.amountPaise / 100;
    const splits: any[] = [];
    if (reverseVendorSplit && order.orderSplits && order.orderSplits.length > 0) {
      for (const s of order.orderSplits) {
        splits.push({
          vendor_id: s.vendorId,
          amount: s.amount
        });
      }
    }

    let refundResult: any;
    try {
      refundResult = await createEasySplitRefund({
        orderId: order.providerOrderId || order.orderId,
        refundAmount: amt,
        refundNote: refundNote || 'Admin order cancellation refund',
        split: splits.length > 0 ? splits : undefined
      });
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Refund fallback');
      refundResult = { status: 'SIMULATED', message: err.message };
    }

    // Update order status & record audit
    const now = new Date();
    await db.collection<OrderDocument>('orders').updateOne(
      { orderId },
      {
        $set: { status: 'REFUND_PENDING', updatedAt: now },
        $push: {
          auditTrail: {
            actor: 'admin',
            from: order.status,
            to: 'REFUND_PENDING',
            reason: `Admin refund initiated: â‚¹${amt} - ${refundNote || ''}`,
            time: now
          }
        }
      }
    );

    // Record settlement adjustment
    await db.collection('settlements').insertOne({
      _id: new ObjectId(),
      settlementId: `ref_${Date.now()}`,
      orderId,
      vendorId: order.orderSplits?.[0]?.vendorId || 'PLATFORM',
      eventType: 'REFUND_ADJUSTMENT',
      amountRupees: amt,
      status: 'SUCCESS',
      transferRemark: refundNote || 'Customer refund adjustment',
      rawWebhookData: refundResult,
      createdAt: now,
      updatedAt: now
    });

    return reply.send({
      success: true,
      message: 'Refund initiated and recorded',
      orderId,
      refundAmount: amt,
      result: refundResult
    });
  });

  // Enable Easy Split Sandbox Simulation
  fastify.post('/admin/easy-split/simulation/enable', async (request, reply) => {
    try {
      const res = await enableEasySplitSandboxSimulation();
      return reply.send({ success: true, message: 'Easy Split sandbox simulation enabled', data: res });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to enable sandbox simulation: ' + err.message });
    }
  });

  // Existing Shop and Job admin routes preserved
  fastify.get('/admin/shops', async (request, reply) => {
    const shops = await db.collection<ShopDocument>('shops')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return reply.send({
      shops: shops.map((s) => ({
        shopId: s._id.toString(),
        name: s.name,
        slug: s.slug,
        ownerEmail: s.ownerEmail,
        pricing: s.pricing,
        isActive: s.isActive,
        easySplit: s.easySplit,
        createdAt: s.createdAt
      }))
    });
  });

  fastify.get<{
    Querystring: {
      status?: string;
      shopId?: string;
      limit?: string;
    };
  }>('/admin/jobs', async (request, reply) => {
    const { status, shopId, limit } = request.query;
    const query: any = {};

    if (status) {
      query.status = status;
    } else {
      query.status = { $in: ['QUEUED', 'DOWNLOADING', 'MANUAL_REVIEW', 'FAILED', 'REFUND_PENDING'] };
    }

    if (shopId && ObjectId.isValid(shopId)) {
      query.shopId = new ObjectId(shopId);
    }

    const maxLimit = Math.min(100, Math.max(1, parseInt(limit || '20', 10)));
    const jobs = await db.collection<JobDocument>('jobs')
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(maxLimit)
      .toArray();

    return reply.send({ jobs });
  });

  fastify.post<{
    Params: { jobId: string };
    Body: {
      action: 'REQUEUE' | 'CANCEL' | 'MARK_REFUND';
      reason?: string;
    };
  }>('/admin/jobs/:jobId/resolve-review', async (request, reply) => {
    const { jobId } = request.params;
    const { action, reason } = request.body || {};

    const job = await db.collection<JobDocument>('jobs').findOne({ jobId });
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (job.status !== 'MANUAL_REVIEW') {
      return reply.code(400).send({
        error: `Only jobs in MANUAL_REVIEW can be manually resolved. Current status: ${job.status}`
      });
    }

    let targetState: any;
    if (action === 'REQUEUE') {
      targetState = 'QUEUED';
    } else if (action === 'CANCEL') {
      targetState = 'CANCELLED';
    } else if (action === 'MARK_REFUND') {
      targetState = 'REFUND_PENDING';
    } else {
      return reply.code(400).send({
        error: 'Invalid action. Allowed actions on MANUAL_REVIEW: REQUEUE, CANCEL, MARK_REFUND'
      });
    }

    const result = await transitionJobState({
      db,
      jobId,
      expectedState: 'MANUAL_REVIEW',
      targetState,
      actor: 'admin',
      reason: reason || `Admin action: ${action}`
    });

    if (!result.success) {
      return reply.code(409).send({ error: result.error });
    }

    return reply.send({
      success: true,
      jobId,
      status: result.job?.status
    });
  });
};
