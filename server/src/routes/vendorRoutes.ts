import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { authenticateAgent, authenticateShop } from '../services/auth.js';
import { createEasySplitVendor, updateEasySplitVendor } from '../services/cashfree.js';
import { ShopDocument, OrderDocument, JobDocument, SettlementDocument, LedgerDocument } from '../types.js';

const DEFAULT_PRINT_OPTIONS = {
  allowColor: true,
  allowBW: true,
  allowSimplex: true,
  allowDuplexLong: true,
  allowDuplexShort: false,
  allow2on1: true,
  allowPortrait: true,
  allowLandscape: true,
  defaultColorMode: 'monochrome' as const,
  defaultOrientation: 'portrait' as const,
  defaultDuplex: 'simplex' as const,
  defaultPagesPerSheet: 1 as const,
  maxCopies: 10,
};

export const vendorRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  async function getAuthenticatedShop(request: any, reply: any): Promise<{ shopId: ObjectId; shop: ShopDocument } | null> {
    const authHeader = (request.headers.authorization || request.headers['x-agent-key']) as string;
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

    // 1. Try agent token
    if (token) {
      const authResult = await authenticateAgent(db, token);
      if (authResult.success && authResult.agent) {
        const shop = await db.collection<ShopDocument>('shops').findOne({ _id: authResult.agent.shopId });
        if (shop) return { shopId: authResult.agent.shopId, shop };
      }
    }

    // 2. Try shop slug & PIN header for vendor portal / mobile
    const shopSlug = (request.headers['x-shop-slug'] || (request.query && request.query.shopSlug)) as string;
    const shopPin = (request.headers['x-shop-pin'] || (request.query && request.query.pin)) as string;
    if (shopSlug && shopPin) {
      const authResult = await authenticateShop(db, shopSlug, shopPin);
      if (authResult.success && authResult.shop) {
        return { shopId: authResult.shop._id, shop: authResult.shop };
      }
    }

    reply.code(401).send({ error: 'Unauthorized: Vendor credentials required' });
    return null;
  }

  // GET /api/vendor/dashboard
  fastify.get('/vendor/dashboard', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalOrders, todayOrders, pendingJobs, completedJobs, failedJobs, rejectedJobs] = await Promise.all([
      db.collection<OrderDocument>('orders').countDocuments({ shopId }),
      db.collection<OrderDocument>('orders').countDocuments({ shopId, createdAt: { $gte: todayStart } }),
      db.collection<JobDocument>('jobs').countDocuments({ shopId, status: { $in: ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED'] } }),
      db.collection<JobDocument>('jobs').countDocuments({ shopId, status: 'COMPLETED', createdAt: { $gte: todayStart } }),
      db.collection<JobDocument>('jobs').countDocuments({ shopId, status: 'FAILED', createdAt: { $gte: todayStart } }),
      db.collection<JobDocument>('jobs').countDocuments({ shopId, status: 'REJECTED', createdAt: { $gte: todayStart } }),
    ]);

    const revenueResult = await db.collection<OrderDocument>('orders').aggregate([
      { $match: { shopId, status: { $in: ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'] }, createdAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$pricing.vendorSharePaise' } } }
    ]).toArray();
    const revenueToday = revenueResult[0]?.total ?? 0;

    const totalRevenueResult = await db.collection<OrderDocument>('orders').aggregate([
      { $match: { shopId, status: { $in: ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'] } } },
      { $group: { _id: null, total: { $sum: '$pricing.vendorSharePaise' } } }
    ]).toArray();
    const totalRevenue = totalRevenueResult[0]?.total ?? 0;

    return reply.send({
      shop: {
        name: shop.name,
        slug: shop.slug,
        ownerEmail: shop.ownerEmail,
        pricing: shop.pricing,
        printOptions: shop.printOptions ?? DEFAULT_PRINT_OPTIONS,
        requireCustomerName: shop.requireCustomerName ?? false,
        payAtCounter: shop.payAtCounter ?? false,
        isActive: shop.isActive
      },
      stats: {
        totalOrders,
        todayOrders,
        pendingJobs,
        completedTodayJobs: completedJobs,
        failedTodayJobs: failedJobs,
        rejectedTodayJobs: rejectedJobs,
        revenueTodayPaise: revenueToday,
        revenueTodayRupees: (revenueToday / 100).toFixed(2),
        totalRevenuePaise: totalRevenue,
        totalRevenueRupees: (totalRevenue / 100).toFixed(2)
      }
    });
  });

  // GET /api/vendor/jobs
  fastify.get<{ Querystring: { page?: string; limit?: string; status?: string } }>(
    '/vendor/jobs',
    async (request, reply) => {
      const auth = await getAuthenticatedShop(request, reply);
      if (!auth) return;
      const { shopId } = auth;

      const page = Math.max(1, parseInt(request.query.page || '1', 10));
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '20', 10)));
      const skip = (page - 1) * limit;

      const filter: any = { shopId };
      if (request.query.status) filter.status = request.query.status;

      const [jobs, total] = await Promise.all([
        db.collection<JobDocument>('jobs').find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        db.collection<JobDocument>('jobs').countDocuments(filter)
      ]);

      const orderIds = [...new Set(jobs.map(j => j.orderId))];
      const orders = await db.collection<OrderDocument>('orders').find({ orderId: { $in: orderIds } }).toArray();
      const orderMap = Object.fromEntries(orders.map(o => [o.orderId, o]));

      const enriched = jobs.map(j => {
        const order = orderMap[j.orderId];
        const pickupCode = order ? ('#' + order.orderId.slice(-4).toUpperCase()) : (j.orderId ? ('#' + j.orderId.slice(-4).toUpperCase()) : '-');
        return {
          jobId: j.jobId,
          orderId: j.orderId,
          pickupCode,
          status: j.status,
          retryCount: j.retryCount,
          failureReason: j.failureReason,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          order: order ? {
            pickupCode,
            amountRupees: (order.pricing.amountPaise / 100).toFixed(2),
            colorMode: order.printOptions.colorMode,
            duplexMode: order.printOptions.duplexMode,
            pagesPerSheet: order.printOptions.pagesPerSheet,
            orientation: order.printOptions.orientation,
            copies: order.printOptions.copies,
            paperSize: order.printOptions.paperSize,
            fileCount: order.files.length,
            files: order.files.map(f => ({
              originalFilename: f.originalFilename,
              fileSize: f.fileSize,
              mimeType: f.mimeType,
              pageCount: f.pageCount
            })),
            customerName: order.customerName || null,
            customerPhone: order.customerPhone || null
          } : null
        };
      });

      return reply.send({
        jobs: enriched,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      });
    }
  );

  // POST /api/vendor/jobs/:jobId/reject
  fastify.post<{ Params: { jobId: string }; Body: { reason?: string } }>(
    '/vendor/jobs/:jobId/reject',
    async (request, reply) => {
      const auth = await getAuthenticatedShop(request, reply);
      if (!auth) return;
      const { shopId } = auth;
      const { jobId } = request.params;
      const reason = request.body?.reason || 'Rejected by vendor';

      const job = await db.collection<JobDocument>('jobs').findOne({ jobId, shopId });
      if (!job) return reply.code(404).send({ error: 'Job not found' });

      if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(job.status)) {
        return reply.code(400).send({ error: `Cannot reject job in status ${job.status}` });
      }

      const now = new Date();
      await db.collection<JobDocument>('jobs').updateOne(
        { jobId, shopId },
        {
          $set: { status: 'REJECTED' as any, failureReason: reason, updatedAt: now },
          $push: {
            auditTrail: {
              actor: 'agent',
              from: job.status,
              to: 'REJECTED' as any,
              reason,
              time: now
            }
          } as any
        }
      );

      // Also update order status to CANCELLED
      await db.collection<OrderDocument>('orders').updateOne(
        { orderId: job.orderId, shopId },
        { $set: { status: 'CANCELLED' as any, updatedAt: now } }
      );

      return reply.send({ success: true, jobId, status: 'REJECTED', reason });
    }
  );

  // GET /api/vendor/jobs/:jobId/files - get download URLs for a job's files
  fastify.get<{ Params: { jobId: string } }>(
    '/vendor/jobs/:jobId/files',
    async (request, reply) => {
      const auth = await getAuthenticatedShop(request, reply);
      if (!auth) return;
      const { shopId } = auth;
      const { jobId } = request.params;

      const job = await db.collection<JobDocument>('jobs').findOne({ jobId, shopId });
      if (!job) return reply.code(404).send({ error: 'Job not found' });

      const order = await db.collection<OrderDocument>('orders').findOne({ orderId: job.orderId, shopId });
      if (!order) return reply.code(404).send({ error: 'Order not found' });

      // Document locked until payment is confirmed
      const accessibleStates = ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'];
      if (!accessibleStates.includes(order.status as string)) {
        return reply.code(403).send({
          error: 'Payment not confirmed. Document is locked until payment is received.',
          orderStatus: order.status
        });
      }

      // Build download URLs (signed R2 URLs via existing agent route logic)
      // Return file info so the agent can fetch
      const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
      return reply.send({
        jobId,
        orderId: job.orderId,
        status: job.status,
        printOptions: order.printOptions,
        customerName: order.customerName || null,
        files: order.files.map(f => ({
          originalFilename: f.originalFilename,
          fileSize: f.fileSize,
          mimeType: f.mimeType,
          pageCount: f.pageCount,
          // Vendor can access files via the agent download-url endpoint
          downloadEndpoint: `${serverUrl}/api/agent/jobs/${jobId}/download-url`
        }))
      });
    }
  );

  // PUT /api/vendor/settings
  fastify.put<{
    Body: {
      shopName?: string;
      shopSlug?: string;
      bwPerPagePaise?: number;
      colorPerPagePaise?: number;
      duplexDiscountPaise?: number;
      requireCustomerName?: boolean;
      payAtCounter?: boolean;
      printOptions?: {
        allowColor?: boolean;
        allowBW?: boolean;
        allowSimplex?: boolean;
        allowDuplexLong?: boolean;
        allowDuplexShort?: boolean;
        allow2on1?: boolean;
        allowPortrait?: boolean;
        allowLandscape?: boolean;
        defaultColorMode?: string;
        defaultOrientation?: string;
        defaultDuplex?: string;
        defaultPagesPerSheet?: number;
        maxCopies?: number;
      };
    }
  }>('/vendor/settings', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const { shopName, shopSlug, bwPerPagePaise, colorPerPagePaise, duplexDiscountPaise, requireCustomerName, payAtCounter, printOptions } = request.body || {};
    const update: any = { updatedAt: new Date() };

    if (shopName) update.name = shopName.trim().slice(0, 80);

    if (shopSlug && typeof shopSlug === 'string') {
      const cleanSlug = shopSlug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      if (cleanSlug && cleanSlug !== shop.slug) {
        const slugExists = await db.collection<ShopDocument>('shops').findOne({ slug: cleanSlug, _id: { $ne: shopId } });
        if (slugExists) {
          return reply.code(409).send({ error: 'This custom URL slug is already in use by another shop.' });
        }
        update.slug = cleanSlug;
      }
    }

    if (typeof bwPerPagePaise === 'number' && bwPerPagePaise >= 0) update['pricing.bwPerPagePaise'] = Math.round(bwPerPagePaise);
    if (typeof colorPerPagePaise === 'number' && colorPerPagePaise >= 0) update['pricing.colorPerPagePaise'] = Math.round(colorPerPagePaise);
    if (typeof duplexDiscountPaise === 'number' && duplexDiscountPaise >= 0) update['pricing.duplexDiscountPaise'] = Math.round(duplexDiscountPaise);
    if (typeof requireCustomerName === 'boolean') update.requireCustomerName = requireCustomerName;
    if (typeof payAtCounter === 'boolean') update.payAtCounter = payAtCounter;

    if (printOptions && typeof printOptions === 'object') {
      const existing = shop.printOptions ?? DEFAULT_PRINT_OPTIONS;
      update.printOptions = {
        allowColor:           printOptions.allowColor           ?? existing.allowColor,
        allowBW:              printOptions.allowBW              ?? existing.allowBW,
        allowSimplex:         printOptions.allowSimplex         ?? existing.allowSimplex,
        allowDuplexLong:      printOptions.allowDuplexLong      ?? existing.allowDuplexLong,
        allowDuplexShort:     printOptions.allowDuplexShort     ?? existing.allowDuplexShort,
        allow2on1:            printOptions.allow2on1            ?? existing.allow2on1,
        allowPortrait:        printOptions.allowPortrait        ?? existing.allowPortrait,
        allowLandscape:       printOptions.allowLandscape       ?? existing.allowLandscape,
        defaultColorMode:     printOptions.defaultColorMode     ?? existing.defaultColorMode,
        defaultOrientation:   printOptions.defaultOrientation   ?? existing.defaultOrientation,
        defaultDuplex:        printOptions.defaultDuplex        ?? existing.defaultDuplex,
        defaultPagesPerSheet: printOptions.defaultPagesPerSheet ?? existing.defaultPagesPerSheet,
        maxCopies:            Math.min(99, Math.max(1, printOptions.maxCopies ?? existing.maxCopies)),
      };
    }

    await db.collection<ShopDocument>('shops').updateOne({ _id: shopId }, { $set: update });
    const updated = await db.collection<ShopDocument>('shops').findOne({ _id: shopId });

    return reply.send({
      success: true,
      shop: {
        name: updated!.name,
        slug: updated!.slug,
        pricing: updated!.pricing,
        printOptions: updated!.printOptions ?? DEFAULT_PRINT_OPTIONS,
        requireCustomerName: updated!.requireCustomerName ?? false,
        payAtCounter: updated!.payAtCounter ?? false,
      }
    });
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // VENDOR EASY SPLIT & SETTLEMENT SELF-SERVICE ENDPOINTS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/vendor/easy-split -- Vendor gets their Easy Split status and bank details
  fastify.get('/vendor/easy-split', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shop } = auth;

    const commissionPercent = shop.easySplit?.commissionPercent ?? 5.0;
    const vendorSharePercent = Number((100 - commissionPercent).toFixed(2));

    return reply.send({
      vendorId: shop.easySplit?.vendorId || `CF_VEND_${shop.slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)}`,
      status: shop.easySplit?.status || 'NOT_REGISTERED',
      bankDetails: shop.easySplit?.bankDetails || null,
      kycDetails: shop.easySplit?.kycDetails || null,
      kycDocuments: shop.easySplit?.kycDocuments || null,
      scheduleOption: shop.easySplit?.scheduleOption || 'T_PLUS_1',
      commissionPercent,
      vendorSharePercent,
      updatedAt: shop.easySplit?.updatedAt || null
    });
  });

  // POST /api/vendor/easy-split/register -- Vendor self-registers bank/UPI for auto-payouts & compliance
  fastify.post<{
    Body: {
      accountHolder: string;
      accountNumber: string;
      ifsc: string;
      upiId?: string;
      pan?: string;
      accountType?: 'INDIVIDUAL' | 'BUSINESS';
      businessType?: string;
      businessName?: string;
      gst?: string;
      address?: {
        street?: string;
        city?: string;
        state?: string;
        postalCode?: string;
      };
    };
  }>('/vendor/easy-split/register', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const {
      accountHolder,
      accountNumber,
      ifsc,
      upiId,
      pan,
      accountType,
      businessType,
      businessName,
      gst,
      address
    } = request.body || {};

    if (!accountHolder || !accountNumber || !ifsc) {
      return reply.code(400).send({
        error: 'Missing required bank details. Please provide Account Holder, Account Number, and IFSC code.'
      });
    }

    const cleanIfsc = ifsc.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
      return reply.code(400).send({
        error: `Invalid IFSC Code "${cleanIfsc}". Indian IFSC codes must be exactly 11 characters (e.g. SBIN0001234, MAHB0000684).`
      });
    }

    // Validate PAN if supplied
    const cleanPan = pan ? pan.trim().toUpperCase() : '';
    if (cleanPan && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(cleanPan)) {
      return reply.code(400).send({
        error: `Invalid PAN "${cleanPan}". Indian PAN numbers must follow the 10-character format (5 letters, 4 digits, 1 letter, e.g. ABCDE1234F).`
      });
    }

    // Validate GST if supplied
    const cleanGst = gst ? gst.trim().toUpperCase() : '';
    if (cleanGst && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(cleanGst)) {
      return reply.code(400).send({
        error: `Invalid GSTIN "${cleanGst}". GST numbers must follow the 15-character Indian GST format (e.g. 27ABCDE1234F1Z5).`
      });
    }

    const vendorId = shop.easySplit?.vendorId || `CF_VEND_${shop.slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)}_${shop._id.toString().slice(-4).toUpperCase()}`;

    let cfResponse: any;
    try {
      cfResponse = await createEasySplitVendor({
        vendorId,
        name: accountHolder.trim(),
        email: shop.ownerEmail || 'vendor@QrPrintDesk.local',
        phone: '9999999999',
        scheduleOption: 1, // T+1 schedule
        bankDetails: {
          accountNumber: accountNumber.trim(),
          accountHolder: accountHolder.trim(),
          ifsc: cleanIfsc
        },
        upi: upiId ? { vpa: upiId.trim() } : undefined,
        kycDetails: {
          accountType: accountType || 'INDIVIDUAL',
          businessType: businessType || 'Retail and Shopping',
          pan: cleanPan || 'AAAPA1234A',
          gst: cleanGst || undefined
        }
      });
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Cashfree registration error');
      return reply.code(400).send({
        error: `Cashfree Vendor Registration Error: ${err.message}`
      });
    }

    const easySplitConfig = {
      vendorId,
      status: 'ACTIVE' as const,
      bankDetails: {
        accountNumber: accountNumber.trim(),
        ifsc: cleanIfsc,
        accountHolder: accountHolder.trim(),
        upiId: upiId ? upiId.trim() : undefined
      },
      kycDetails: {
        pan: cleanPan || shop.easySplit?.kycDetails?.pan,
        businessName: businessName?.trim() || shop.name,
        businessType: businessType?.trim() || 'Retail and Shopping',
        accountType: accountType || 'INDIVIDUAL',
        gst: cleanGst || shop.easySplit?.kycDetails?.gst,
        address: address || shop.easySplit?.kycDetails?.address
      },
      kycDocuments: shop.easySplit?.kycDocuments || {},
      scheduleOption: 'T_PLUS_1',
      commissionPercent: shop.easySplit?.commissionPercent ?? 5.0,
      cfResponse,
      updatedAt: new Date()
    };

    await db.collection<ShopDocument>('shops').updateOne(
      { _id: shopId },
      {
        $set: {
          easySplit: easySplitConfig,
          updatedAt: new Date()
        }
      }
    );

    return reply.send({
      success: true,
      message: 'Bank account connected! Easy Split payouts are now ACTIVE on your account.',
      easySplit: easySplitConfig
    });
  });

  // POST /api/vendor/easy-split/upload-kyc -- Upload KYC Documents (PAN Card, Bank Proof / Cheque)
  fastify.post('/vendor/easy-split/upload-kyc', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const file = await (request as any).file();
    if (!file) {
      return reply.code(400).send({ error: 'No document uploaded' });
    }

    const docType = ((file.fields?.docType?.value as string) || 'bank_proof').toLowerCase();
    const allowedTypes = ['pan_card', 'bank_proof', 'shop_license'];
    if (!allowedTypes.includes(docType)) {
      return reply.code(400).send({ error: `Invalid docType. Allowed: ${allowedTypes.join(', ')}` });
    }

    const ext = path.extname(file.filename) || '.jpg';
    const safeFilename = `${shopId.toString()}_${docType}_${Date.now()}${ext}`;
    const kycDir = path.join(process.cwd(), 'data', 'kyc');
    if (!fs.existsSync(kycDir)) {
      fs.mkdirSync(kycDir, { recursive: true });
    }
    const savePath = path.join(kycDir, safeFilename);

    const buffer = await file.toBuffer();
    fs.writeFileSync(savePath, buffer);

    const docMeta = {
      filename: file.filename,
      uploadedAt: new Date(),
      size: buffer.length,
      path: savePath
    };

    await db.collection<ShopDocument>('shops').updateOne(
      { _id: shopId },
      {
        $set: {
          [`easySplit.kycDocuments.${docType}`]: docMeta,
          updatedAt: new Date()
        }
      }
    );

    return reply.send({
      success: true,
      message: `${docType.replace('_', ' ').toUpperCase()} uploaded successfully`,
      docType,
      filename: file.filename,
      size: buffer.length
    });
  });

  // GET /api/vendor/easy-split/kyc-document/:docType -- Stream uploaded KYC document
  fastify.get<{ Params: { docType: string } }>('/vendor/easy-split/kyc-document/:docType', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shop } = auth;
    const { docType } = request.params;

    const doc = shop.easySplit?.kycDocuments?.[docType];
    if (!doc || !fs.existsSync(doc.path)) {
      return reply.code(404).send({ error: 'Document not found' });
    }

    const ext = path.extname(doc.path).toLowerCase();
    const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
    const stream = fs.createReadStream(doc.path);
    return reply.type(mime).send(stream);
  });

  // PUT /api/vendor/easy-split/bank-details -- Vendor updates their bank or UPI
  fastify.put<{
    Body: {
      accountHolder?: string;
      accountNumber?: string;
      ifsc?: string;
      upiId?: string;
    };
  }>('/vendor/easy-split/bank-details', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    if (!shop.easySplit?.vendorId) {
      return reply.code(400).send({ error: 'Please register your Easy Split account first before updating details.' });
    }

    const { accountHolder, accountNumber, ifsc, upiId } = request.body || {};
    const currentBank = shop.easySplit.bankDetails || {};

    const updatedBank = {
      accountHolder: (accountHolder || currentBank.accountHolder || shop.name).trim(),
      accountNumber: (accountNumber || currentBank.accountNumber || '').trim(),
      ifsc: (ifsc || currentBank.ifsc || '').toUpperCase().trim(),
      upiId: upiId !== undefined ? upiId.trim() : currentBank.upiId
    };

    let cfResponse: any;
    try {
      cfResponse = await updateEasySplitVendor(shop.easySplit.vendorId, {
        name: updatedBank.accountHolder,
        bankDetails: updatedBank.accountNumber ? {
          accountNumber: updatedBank.accountNumber,
          accountHolder: updatedBank.accountHolder,
          ifsc: updatedBank.ifsc
        } : undefined,
        upi: updatedBank.upiId ? { vpa: updatedBank.upiId } : undefined
      });
    } catch (err: any) {
      request.log.warn({ err: err.message }, 'Cashfree update vendor warning');
      cfResponse = { status: 'SIMULATED', message: err.message };
    }

    await db.collection<ShopDocument>('shops').updateOne(
      { _id: shopId },
      {
        $set: {
          'easySplit.bankDetails': updatedBank,
          'easySplit.updatedAt': new Date(),
          updatedAt: new Date()
        }
      }
    );

    return reply.send({
      success: true,
      message: 'Bank details updated successfully',
      bankDetails: updatedBank
    });
  });

  // GET /api/vendor/easy-split/settlements -- Vendor tracks their settlement payout history
  fastify.get<{
    Querystring: { limit?: string };
  }>('/vendor/easy-split/settlements', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const vendorId = shop.easySplit?.vendorId;
    const query: any = {
      $or: [{ shopId }, { vendorId: vendorId || 'NONE' }]
    };

    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10)));
    const settlements = await db.collection<SettlementDocument>('settlements')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return reply.send({
      vendorId,
      settlements: settlements.map(s => ({
        settlementId: s.settlementId,
        orderId: s.orderId,
        amountRupees: s.amountRupees,
        eventType: s.eventType,
        status: s.status,
        transferRemark: s.transferRemark,
        date: s.createdAt
      }))
    });
  });

  // GET /api/vendor/easy-split/earnings -- Vendor views financial dashboard
  fastify.get('/vendor/easy-split/earnings', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId, shop } = auth;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayAgg, totalAgg, recentSettled] = await Promise.all([
      db.collection<LedgerDocument>('ledger').aggregate([
        { $match: { shopId, createdAt: { $gte: todayStart } } },
        {
          $group: {
            _id: null,
            grossPaise: { $sum: '$grossPaise' },
            platformFeePaise: { $sum: '$platformFeePaise' },
            vendorSharePaise: { $sum: '$vendorSharePaise' }
          }
        }
      ]).toArray(),
      db.collection<LedgerDocument>('ledger').aggregate([
        { $match: { shopId } },
        {
          $group: {
            _id: null,
            grossPaise: { $sum: '$grossPaise' },
            platformFeePaise: { $sum: '$platformFeePaise' },
            vendorSharePaise: { $sum: '$vendorSharePaise' }
          }
        }
      ]).toArray(),
      db.collection<SettlementDocument>('settlements').aggregate([
        { $match: { $or: [{ shopId }, { vendorId: shop.easySplit?.vendorId || 'NONE' }], status: 'SUCCESS' } },
        { $group: { _id: null, totalSettledRupees: { $sum: '$amountRupees' } } }
      ]).toArray()
    ]);

    const todayVendorShare = ((todayAgg[0]?.vendorSharePaise || 0) / 100);
    const totalVendorShare = ((totalAgg[0]?.vendorSharePaise || 0) / 100);
    const totalGross = ((totalAgg[0]?.grossPaise || 0) / 100);
    const totalPlatformFee = ((totalAgg[0]?.platformFeePaise || 0) / 100);
    const settledToBank = recentSettled[0]?.totalSettledRupees || 0;

    return reply.send({
      easySplitStatus: shop.easySplit?.status || 'NOT_REGISTERED',
      todayEarningsRupees: todayVendorShare.toFixed(2),
      totalEarningsRupees: totalVendorShare.toFixed(2),
      totalGrossRupees: totalGross.toFixed(2),
      totalPlatformFeeRupees: totalPlatformFee.toFixed(2),
      settledToBankRupees: Number(settledToBank).toFixed(2),
      pendingSettlementRupees: Math.max(0, totalVendorShare - settledToBank).toFixed(2),
      commissionPercent: shop.easySplit?.commissionPercent ?? 5.0,
      bankAccountMasked: shop.easySplit?.bankDetails?.accountNumber
        ? 'â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ ' + shop.easySplit.bankDetails.accountNumber.slice(-4)
        : null,
      upiId: shop.easySplit?.bankDetails?.upiId || null
    });
  });

  // GET /api/vendor/analytics -- Comprehensive shop analytics and revenue breakdown
  fastify.get<{
    Querystring: { period?: 'today' | 'week' | 'month' | 'all' };
  }>('/vendor/analytics', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId } = auth;

    const period = request.query.period || 'today';
    const now = new Date();
    let startDate: Date;

    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else if (period === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    } else {
      startDate = new Date(0); // All time
    }

    const orders = await db.collection<OrderDocument>('orders')
      .find({ shopId, createdAt: { $gte: startDate } })
      .toArray();

    const paidOrders = orders.filter(o => ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'].includes(o.status));
    const totalGrossPaise = paidOrders.reduce((sum, o) => sum + (o.pricing?.amountPaise || 0), 0);
    const totalVendorPaise = paidOrders.reduce((sum, o) => sum + (o.pricing?.vendorSharePaise || 0), 0);
    const totalPlatformPaise = paidOrders.reduce((sum, o) => sum + (o.pricing?.platformFeePaise || 0), 0);

    let totalPages = 0;
    let bwPages = 0;
    let colorPages = 0;
    let duplexSheets = 0;
    let simplexSheets = 0;

    for (const o of paidOrders) {
      const orderPages = (o.files || []).reduce((acc, f) => acc + (f.pageCount || 1), 0) * (o.printOptions?.copies || 1);
      totalPages += orderPages;
      if (o.printOptions?.colorMode === 'color') {
        colorPages += orderPages;
      } else {
        bwPages += orderPages;
      }
      if (o.printOptions?.duplexMode && o.printOptions.duplexMode !== 'simplex') {
        duplexSheets += Math.ceil(orderPages / 2);
      } else {
        simplexSheets += orderPages;
      }
    }

    const completedCount = orders.filter(o => o.status === 'COMPLETED').length;
    const failedCount = orders.filter(o => o.status === 'FAILED').length;
    const cancelledCount = orders.filter(o => o.status === 'CANCELLED').length;

    // Past 7 days daily breakdown for mini-chart
    const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const recentOrders = await db.collection<OrderDocument>('orders')
      .find({
        shopId,
        createdAt: { $gte: sevenDaysAgo },
        status: { $in: ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'] }
      })
      .toArray();

    const dailyMap: Record<string, { date: string; orders: number; grossPaise: number; vendorPaise: number; totalPages: number }> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().split('T')[0];
      const displayDate = d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });
      dailyMap[key] = { date: displayDate, orders: 0, grossPaise: 0, vendorPaise: 0, totalPages: 0 };
    }

    for (const o of recentOrders) {
      const key = o.createdAt.toISOString().split('T')[0];
      if (dailyMap[key]) {
        dailyMap[key].orders++;
        dailyMap[key].grossPaise += o.pricing?.amountPaise || 0;
        dailyMap[key].vendorPaise += o.pricing?.vendorSharePaise || 0;
        const orderPages = (o.files || []).reduce((acc, f) => acc + (f.pageCount || 1), 0) * (o.printOptions?.copies || 1);
        dailyMap[key].totalPages += orderPages;
      }
    }

    const dailyTrend = Object.values(dailyMap).map(d => ({
      date: d.date,
      orders: d.orders,
      grossRupees: (d.grossPaise / 100).toFixed(2),
      vendorShareRupees: (d.vendorPaise / 100).toFixed(2),
      totalPages: d.totalPages
    }));

    return reply.send({
      period,
      summary: {
        totalOrders: paidOrders.length,
        grossRupees: (totalGrossPaise / 100).toFixed(2),
        vendorShareRupees: (totalVendorPaise / 100).toFixed(2),
        platformFeeRupees: (totalPlatformPaise / 100).toFixed(2),
        avgOrderRupees: paidOrders.length > 0 ? (totalGrossPaise / paidOrders.length / 100).toFixed(2) : '0.00',
        completedOrders: completedCount,
        failedOrders: failedCount,
        cancelledOrders: cancelledCount
      },
      volume: {
        totalPages,
        bwPages,
        colorPages,
        duplexSheets,
        simplexSheets
      },
      dailyTrend
    });
  });

  // GET /api/vendor/analytics/monthly -- Last 12 months of archived monthly summaries
  // Upserts the current month on each call; past months are read-only from the archive collection.
  fastify.get('/vendor/analytics/monthly', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId } = auth;

    const now = new Date();
    const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

    // Always recompute current month from live orders and upsert
    const curOrders = await db.collection<OrderDocument>('orders')
      .find({ shopId, createdAt: { $gte: monthStart }, status: { $in: ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED'] } })
      .toArray();

    let curGross = 0, curVendor = 0, curBw = 0, curColor = 0, curPages = 0;
    for (const o of curOrders) {
      curGross += o.pricing?.amountPaise || 0;
      curVendor += o.pricing?.vendorSharePaise || 0;
      const pg = (o.files || []).reduce((a, f) => a + (f.pageCount || 1), 0) * (o.printOptions?.copies || 1);
      curPages += pg;
      if (o.printOptions?.colorMode === 'color') curColor += pg; else curBw += pg;
    }

    await db.collection('analytics_monthly').updateOne(
      { shopId, yearMonth: curYM },
      { $set: { shopId, yearMonth: curYM, totalOrders: curOrders.length, grossPaise: curGross, vendorSharePaise: curVendor, bwPages: curBw, colorPages: curColor, totalPages: curPages, updatedAt: now } },
      { upsert: true }
    );

    // Fetch last 12 months from archive (sorted newest first)
    const archive = await db.collection('analytics_monthly')
      .find({ shopId })
      .sort({ yearMonth: -1 })
      .limit(12)
      .toArray();

    const months = archive.map((m: any) => ({
      yearMonth: m.yearMonth,
      totalOrders: m.totalOrders || 0,
      grossRupees: ((m.grossPaise || 0) / 100).toFixed(2),
      vendorShareRupees: ((m.vendorSharePaise || 0) / 100).toFixed(2),
      bwPages: m.bwPages || 0,
      colorPages: m.colorPages || 0,
      totalPages: m.totalPages || 0
    }));

    return reply.send({ months });
  });

  // GET /api/vendor/transactions -- Detailed itemized ledger transactions with pickup codes
  fastify.get<{
    Querystring: { page?: string; limit?: string };
  }>('/vendor/transactions', async (request, reply) => {
    const auth = await getAuthenticatedShop(request, reply);
    if (!auth) return;
    const { shopId } = auth;

    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '30', 10)));
    const skip = (page - 1) * limit;

    const [ledgerEntries, total] = await Promise.all([
      db.collection<LedgerDocument>('ledger')
        .find({ shopId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection<LedgerDocument>('ledger').countDocuments({ shopId })
    ]);

    const orderIds = ledgerEntries.map(l => l.orderId);
    const orders = await db.collection<OrderDocument>('orders').find({ orderId: { $in: orderIds } }).toArray();
    const orderMap = Object.fromEntries(orders.map(o => [o.orderId, o]));

    const transactions = ledgerEntries.map(l => {
      const order = orderMap[l.orderId];
      const pickupCode = order ? ('#' + order.orderId.slice(-4).toUpperCase()) : ('#' + l.orderId.slice(-4).toUpperCase());
      const pageCount = order ? (order.files || []).reduce((acc, f) => acc + (f.pageCount || 1), 0) * (order.printOptions?.copies || 1) : 1;
      return {
        id: l._id.toString(),
        orderId: l.orderId,
        pickupCode,
        grossRupees: (l.grossPaise / 100).toFixed(2),
        platformFeeRupees: (l.platformFeePaise / 100).toFixed(2),
        vendorShareRupees: (l.vendorSharePaise / 100).toFixed(2),
        settled: l.settled,
        settlementTxnId: l.settlementTxnId,
        customerName: order?.customerName || 'Walk-in Customer',
        customerPhone: order?.customerPhone || null,
        pageCount,
        colorMode: order?.printOptions?.colorMode || 'monochrome',
        date: l.createdAt
      };
    });

    return reply.send({
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  });

  // GET /api/shops/:shopSlug/config  -- public endpoint for customer PWA
  fastify.get<{ Params: { shopSlug: string } }>(
    '/shops/:shopSlug/config',
    async (request, reply) => {
      const shop = await db.collection<ShopDocument>('shops').findOne({ slug: request.params.shopSlug, isActive: true });
      if (!shop) return reply.code(404).send({ error: 'Shop not found' });

      return reply.send({
        shopName: shop.name,
        slug: shop.slug,
        pricing: {
          bwPerPageRupees: (shop.pricing.bwPerPagePaise / 100).toFixed(2),
          colorPerPageRupees: (shop.pricing.colorPerPagePaise / 100).toFixed(2),
          duplexDiscountRupees: (shop.pricing.duplexDiscountPaise / 100).toFixed(2),
        },
        printOptions: shop.printOptions ?? DEFAULT_PRINT_OPTIONS,
        requireCustomerName: shop.requireCustomerName ?? false,
      });
    }
  );
};
