import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { transitionJobState } from '../services/stateMachine.js';
import { JobDocument, ShopDocument, OrderDocument } from '../types.js';

export const adminRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // List all shops
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
        createdAt: s.createdAt
      }))
    });
  });

  // List pending, failed, or manual review jobs
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

  // Admin action on MANUAL_REVIEW jobs
  // NOTE: Strict rule: No endpoint may mark an order paid or completed without payment verification.
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
