import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { authenticateShop, authenticateAgent, generateSecureToken, hashToken } from '../services/auth.js';
import { AgentDocument, ShopDocument } from '../types.js';

export const authRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const db = opts.db;

  // Shopkeeper Login
  fastify.post<{ Body: { shopSlug: string; pin: string } }>('/auth/shop/login', async (request, reply) => {
    const { shopSlug, pin } = request.body || {};
    if (!shopSlug || !pin) {
      return reply.code(400).send({ error: 'Missing shopSlug or pin' });
    }

    const authResult = await authenticateShop(db, shopSlug, pin);
    if (!authResult.success || !authResult.shop) {
      return reply.code(401).send({ error: authResult.error || 'Authentication failed' });
    }

    const shop = authResult.shop;
    return reply.send({
      shopId: shop._id.toString(),
      name: shop.name,
      slug: shop.slug,
      pricing: shop.pricing
    });
  });

  // Create new Agent token (Shopkeeper/Admin creates token for printer PC)
  fastify.post<{ Body: { shopId: string; name: string } }>('/auth/agent/create-token', async (request, reply) => {
    const { shopId, name } = request.body || {};
    if (!shopId || !name) {
      return reply.code(400).send({ error: 'Missing shopId or name' });
    }

    if (!ObjectId.isValid(shopId)) {
      return reply.code(400).send({ error: 'Invalid shopId' });
    }

    const { secret, hash } = generateSecureToken();
    const now = new Date();

    const agentDoc: AgentDocument = {
      _id: new ObjectId(),
      shopId: new ObjectId(shopId),
      name,
      tokenHash: hash,
      isRevoked: false,
      createdAt: now,
      updatedAt: now
    };

    await db.collection<AgentDocument>('agents').insertOne(agentDoc);

    // Return the secret ONCE. It is never stored in plain text.
    return reply.code(201).send({
      agentId: agentDoc._id.toString(),
      token: secret,
      warning: 'Store this token safely. It will not be shown again.'
    });
  });

  // Revoke an Agent token
  fastify.post<{ Body: { agentId: string } }>('/auth/agent/revoke-token', async (request, reply) => {
    const { agentId } = request.body || {};
    if (!agentId || !ObjectId.isValid(agentId)) {
      return reply.code(400).send({ error: 'Invalid agentId' });
    }

    const res = await db.collection<AgentDocument>('agents').updateOne(
      { _id: new ObjectId(agentId) },
      { $set: { isRevoked: true, updatedAt: new Date() } }
    );

    if (res.matchedCount === 0) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    return reply.send({ success: true, message: 'Agent token revoked' });
  });

  // Verify Agent token
  fastify.get('/auth/agent/verify', async (request, reply) => {
    const authHeader = request.headers.authorization || (request.headers['x-agent-key'] as string);
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : '';

    const authResult = await authenticateAgent(db, token);
    if (!authResult.success || !authResult.agent) {
      return reply.code(401).send({ error: authResult.error || 'Unauthorized' });
    }

    return reply.send({
      valid: true,
      agentId: authResult.agent._id.toString(),
      shopId: authResult.agent.shopId.toString(),
      name: authResult.agent.name
    });
  });
};
