import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { authenticateAgent } from '../services/auth.js';
import { getPresignedDownloadUrl } from '../services/r2.js';
import { reportPrintOutcome, transitionJobState } from '../services/stateMachine.js';
import { JobDocument, OrderDocument } from '../types.js';
import { WebSocketHub } from '../services/wsHub.js';

export const agentRoutes: FastifyPluginAsync<{ db: Db; wsHub?: WebSocketHub }> = async (fastify, opts) => {
  const db = opts.db;
  const wsHub = opts.wsHub;

  // Agent auth hook for all /agent/* routes
  fastify.addHook('preHandler', async (request, reply) => {
    const authHeader = request.headers.authorization || (request.headers['x-agent-key'] as string);
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : '';

    const authResult = await authenticateAgent(db, token);
    if (!authResult.success || !authResult.agent) {
      return reply.code(401).send({ error: authResult.error || 'Agent authentication required' });
    }

    (request as any).agent = authResult.agent;
  });

  // Get paginated pending jobs for this agent's shop
  fastify.get<{
    Querystring: {
      page?: string;
      limit?: string;
    };
  }>('/agent/jobs', async (request, reply) => {
    const agent = (request as any).agent;
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '10', 10)));
    const skip = (page - 1) * limit;

    const query = {
      shopId: agent.shopId,
      status: { $in: ['QUEUED', 'DOWNLOADING'] as any }
    };

    const [jobs, total] = await Promise.all([
      db.collection<JobDocument>('jobs')
        .find(query)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection<JobDocument>('jobs').countDocuments(query)
    ]);

    // Update agent's heartbeat timestamp in memory/background without failing
    db.collection('agents').updateOne(
      { _id: agent._id },
      { $set: { lastHeartbeat: new Date() } }
    ).catch(() => {});

    return reply.send({
      jobs: jobs.map((j) => ({
        jobId: j.jobId,
        orderId: j.orderId,
        status: j.status,
        retryCount: j.retryCount,
        createdAt: j.createdAt
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  });

  // Get job metadata and presigned GET download URL
  fastify.get<{ Params: { jobId: string } }>('/agent/jobs/:jobId/download-url', async (request, reply) => {
    const agent = (request as any).agent;
    const { jobId } = request.params;

    const job = await db.collection<JobDocument>('jobs').findOne({ jobId, shopId: agent.shopId });
    if (!job) {
      return reply.code(404).send({ error: 'Job not found or unauthorized' });
    }

    const order = await db.collection<OrderDocument>('orders').findOne({ orderId: job.orderId, shopId: agent.shopId });
    if (!order) {
      return reply.code(404).send({ error: 'Associated order not found' });
    }

    // PAYMENT GATE: Document is locked until payment is confirmed or Pay at Counter
    const accessibleStates = ['PAID', 'QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'COMPLETED', 'PAY_AT_COUNTER_PENDING'];
    if (!accessibleStates.includes(order.status as string)) {
      return reply.code(403).send({
        error: 'Payment not confirmed. Document is locked until payment is received.',
        orderStatus: order.status
      });
    }

    // Transition state from QUEUED to DOWNLOADING if needed
    if (job.status === 'QUEUED') {
      await transitionJobState({
        db,
        jobId: job.jobId,
        expectedState: 'QUEUED',
        targetState: 'DOWNLOADING',
        actor: 'agent',
        actorId: agent._id.toString(),
        reason: 'Agent started downloading document'
      });
    }

    // Generate short-lived presigned GET URLs for all order files (300 seconds TTL)
    const filesWithUrls = await Promise.all(
      order.files.map(async (f) => ({
        originalFilename: f.originalFilename,
        mimeType: f.mimeType,
        pageCount: f.pageCount,
        fileSize: f.fileSize,
        downloadUrl: await getPresignedDownloadUrl(f.fileKey, 300)
      }))
    );

    return reply.send({
      jobId: job.jobId,
      orderId: order.orderId,
      printOptions: order.printOptions,
      files: filesWithUrls
    });
  });

  // Report job print outcome
  fastify.post<{
    Params: { jobId: string };
    Body: {
      outcome: 'SUCCESS' | 'UNCERTAIN' | 'DEFINITIVE_FAILURE';
      opId?: string;
      reason?: string;
    };
  }>('/agent/jobs/:jobId/status', async (request, reply) => {
    const agent = (request as any).agent;
    const { jobId } = request.params;
    const { outcome, opId, reason } = request.body || {};

    if (!outcome || !['SUCCESS', 'UNCERTAIN', 'DEFINITIVE_FAILURE'].includes(outcome)) {
      return reply.code(400).send({ error: 'Invalid or missing outcome parameter' });
    }

    const job = await db.collection<JobDocument>('jobs').findOne({ jobId, shopId: agent.shopId });
    if (!job) {
      return reply.code(404).send({ error: 'Job not found or cross-shop access denied' });
    }

    const result = await reportPrintOutcome({
      db,
      jobId,
      outcome,
      actorId: agent._id.toString(),
      opId,
      reason
    });

    if (!result.success) {
      return reply.code(409).send({ error: result.error });
    }

    if (wsHub && result.job) {
      wsHub.broadcastToShop(agent.shopId, {
        type: 'job_status_change',
        jobId,
        orderId: result.job.orderId,
        status: result.job.status
      });
    }

    return reply.send({
      success: true,
      jobId,
      status: result.job?.status,
      idempotentHit: !!result.idempotentHit
    });
  });
};
