import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { authenticateShop, authenticateAgent, generateSecureToken, hashToken } from '../services/auth.js';
import { verifyGoogleIdToken } from '../services/googleAuth.js';
import { getShopSubscription } from '../services/subscription.js';
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

  // Self-register: shop slug + PIN + station name → returns agent token (one call)
  // Used by the Windows agent on first run to register itself.
  fastify.post<{
    Body: { shopSlug: string; pin: string; agentName: string };
  }>('/auth/agent/self-register', async (request, reply) => {
    const { shopSlug, pin, agentName } = request.body || {};
    if (!shopSlug || !pin || !agentName) {
      return reply.code(400).send({ error: 'Missing shopSlug, pin or agentName' });
    }

    // Authenticate shop
    const authResult = await authenticateShop(db, shopSlug, pin);
    if (!authResult.success || !authResult.shop) {
      return reply.code(401).send({ error: authResult.error || 'Invalid shop credentials' });
    }

    const shopId = authResult.shop._id;
    const { secret, hash } = generateSecureToken();
    const now = new Date();

    const agentDoc: AgentDocument = {
      _id: new ObjectId(),
      shopId,
      name: agentName.trim().slice(0, 60),
      tokenHash: hash,
      isRevoked: false,
      createdAt: now,
      updatedAt: now
    };

    await db.collection<AgentDocument>('agents').insertOne(agentDoc);

    return reply.code(201).send({
      agentToken: secret,
      agentId: agentDoc._id.toString(),
      shopId: shopId.toString(),
      shopName: authResult.shop.name,
      agentName: agentDoc.name
    });
  });

  // Vendor Registration: creates a new shop + agent token in one call
  // Body: { shopName, ownerEmail, pin, stationName }
  fastify.post<{
    Body: { shopName: string; ownerEmail: string; pin: string; stationName: string };
  }>('/auth/vendor/register', async (request, reply) => {
    const { shopName, ownerEmail, pin, stationName } = request.body || {};
    if (!shopName || !ownerEmail || !pin || !stationName) {
      return reply.code(400).send({ error: 'Missing shopName, ownerEmail, pin or stationName' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
      return reply.code(400).send({ error: 'Invalid email address' });
    }
    if (!/^\d{4,8}$/.test(pin)) {
      return reply.code(400).send({ error: 'PIN must be 4-8 digits' });
    }

    // Check if email already registered
    const existing = await db.collection<ShopDocument>('shops').findOne({ ownerEmail: ownerEmail.trim().toLowerCase() });
    if (existing) {
      return reply.code(409).send({ error: 'This email is already registered. Please click Login instead.' });
    }

    // Generate slug from shopName
    let baseSlug = shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!baseSlug) baseSlug = 'shop';

    // Ensure slug uniqueness
    let slug = baseSlug;
    let suffix = 1;
    while (await db.collection<ShopDocument>('shops').findOne({ slug })) {
      slug = `${baseSlug}-${suffix++}`;
    }

    const { hash: pinHash } = { hash: hashToken(pin) };
    const now = new Date();

    const shopDoc: ShopDocument = {
      _id: new ObjectId(),
      name: shopName.trim().slice(0, 80),
      slug,
      ownerEmail: ownerEmail.trim().toLowerCase(),
      pinHash,
      pricing: {
        bwPerPagePaise: 150,
        colorPerPagePaise: 500,
        duplexDiscountPaise: 0
      },
      isActive: true,
      createdAt: now,
      updatedAt: now
    };

    await db.collection<ShopDocument>('shops').insertOne(shopDoc);

    // Create agent token
    const { secret, hash: tokenHash } = generateSecureToken();
    const agentDoc: AgentDocument = {
      _id: new ObjectId(),
      shopId: shopDoc._id,
      name: stationName.trim().slice(0, 60),
      tokenHash,
      isRevoked: false,
      createdAt: now,
      updatedAt: now
    };
    await db.collection<AgentDocument>('agents').insertOne(agentDoc);

    return reply.code(201).send({
      agentToken: secret,
      agentId: agentDoc._id.toString(),
      shopId: shopDoc._id.toString(),
      shopName: shopDoc.name,
      shopSlug: slug,
      ownerEmail: shopDoc.ownerEmail,
      stationName: agentDoc.name,
      message: 'Registration successful. Your shop is ready.'
    });
  });

  // Vendor SaaS Email + PIN Login: Auto-provisions / retrieves station credentials seamlessly
  // Body: { email, pin, stationName? }
  fastify.post<{
    Body: { email: string; pin: string; stationName?: string };
  }>('/auth/vendor/login', async (request, reply) => {
    const { email, pin, stationName } = request.body || {};
    if (!email || !pin) {
      return reply.code(400).send({ error: 'Email and PIN are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const shop = await db.collection<ShopDocument>('shops').findOne({ ownerEmail: cleanEmail, isActive: true });
    if (!shop) {
      return reply.code(404).send({ error: 'No active shop found with this email. Please register first.' });
    }

    // Verify PIN
    const incomingPinHash = hashToken(pin);
    if (shop.pinHash !== incomingPinHash) {
      return reply.code(401).send({ error: 'Incorrect PIN. Please try again.' });
    }

    // Find active agent or provision a new one for this station
    const stationLabel = (stationName || 'Main Station').trim().slice(0, 60);
    const existingAgent = await db.collection<AgentDocument>('agents').findOne({
      shopId: shop._id,
      name: stationLabel,
      isRevoked: false
    });

    let secretToken: string;
    let agentIdStr: string;

    if (existingAgent) {
      // Re-issue a fresh token for this station securely
      const { secret, hash: tokenHash } = generateSecureToken();
      await db.collection<AgentDocument>('agents').updateOne(
        { _id: existingAgent._id },
        { $set: { tokenHash, updatedAt: new Date() } }
      );
      secretToken = secret;
      agentIdStr = existingAgent._id.toString();
    } else {
      // Create new agent for this station
      const { secret, hash: tokenHash } = generateSecureToken();
      const now = new Date();
      const newAgent: AgentDocument = {
        _id: new ObjectId(),
        shopId: shop._id,
        name: stationLabel,
        tokenHash,
        isRevoked: false,
        createdAt: now,
        updatedAt: now
      };
      await db.collection<AgentDocument>('agents').insertOne(newAgent);
      secretToken = secret;
      agentIdStr = newAgent._id.toString();
    }

    return reply.send({
      success: true,
      agentToken: secretToken,
      agentId: agentIdStr,
      shopId: shop._id.toString(),
      shopName: shop.name,
      shopSlug: shop.slug,
      ownerEmail: shop.ownerEmail,
      stationName: stationLabel,
      pricing: shop.pricing,
      printOptions: shop.printOptions
    });
  });

  // ── Google OAuth 2.0 Vendor Sign-In & Instant Onboarding ───────────────────
  fastify.post<{
    Body: { idToken?: string; credential?: string; stationName?: string };
  }>('/auth/google', async (request, reply) => {
    const rawToken = request.body?.idToken || request.body?.credential || '';
    if (!rawToken) {
      return reply.code(400).send({ error: 'Missing Google ID token or credential' });
    }

    const verifyResult = await verifyGoogleIdToken(rawToken);
    if (!verifyResult.success || !verifyResult.user) {
      return reply.code(401).send({ error: verifyResult.error || 'Invalid Google credential' });
    }

    const { email, name, googleId, picture } = verifyResult.user;
    const cleanEmail = email.trim().toLowerCase();

    // Check if shop exists
    let shop = await db.collection<ShopDocument>('shops').findOne({
      $or: [{ ownerEmail: cleanEmail }, { googleId }]
    });

    const now = new Date();
    const stationLabel = (request.body?.stationName || 'Main Station').trim().slice(0, 60);

    if (shop) {
      // Update googleId and avatar if missing
      await db.collection<ShopDocument>('shops').updateOne(
        { _id: shop._id },
        {
          $set: {
            googleId,
            avatarUrl: picture || shop.avatarUrl,
            updatedAt: now
          }
        }
      );
    } else {
      // Auto-provision brand new merchant shop with Free Starter Trial
      let baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35);
      if (!baseSlug) baseSlug = 'store';

      let slug = baseSlug;
      let suffix = 1;
      while (await db.collection<ShopDocument>('shops').findOne({ slug })) {
        slug = `${baseSlug}-${suffix++}`;
      }

      const randomBackupPin = String(Math.floor(1000 + Math.random() * 9000));
      const pinHash = hashToken(randomBackupPin);

      const newShop: ShopDocument = {
        _id: new ObjectId(),
        name: `${name}'s Xerox`,
        slug,
        ownerEmail: cleanEmail,
        googleId,
        avatarUrl: picture,
        pinHash,
        pricing: {
          bwPerPagePaise: 150,
          colorPerPagePaise: 500,
          duplexDiscountPaise: 0
        },
        isActive: true,
        createdAt: now,
        updatedAt: now
      };

      await db.collection<ShopDocument>('shops').insertOne(newShop);
      shop = newShop;
    }

    // Provision or retrieve station agent token
    const existingAgent = await db.collection<AgentDocument>('agents').findOne({
      shopId: shop._id,
      name: stationLabel,
      isRevoked: false
    });

    let secretToken: string;
    let agentIdStr: string;

    if (existingAgent) {
      const { secret, hash: tokenHash } = generateSecureToken();
      await db.collection<AgentDocument>('agents').updateOne(
        { _id: existingAgent._id },
        { $set: { tokenHash, updatedAt: now } }
      );
      secretToken = secret;
      agentIdStr = existingAgent._id.toString();
    } else {
      const { secret, hash: tokenHash } = generateSecureToken();
      const newAgent: AgentDocument = {
        _id: new ObjectId(),
        shopId: shop._id,
        name: stationLabel,
        tokenHash,
        isRevoked: false,
        createdAt: now,
        updatedAt: now
      };
      await db.collection<AgentDocument>('agents').insertOne(newAgent);
      secretToken = secret;
      agentIdStr = newAgent._id.toString();
    }

    // Fetch subscription status & limits
    const subInfo = await getShopSubscription(db, shop._id);

    return reply.send({
      success: true,
      agentToken: secretToken,
      agentId: agentIdStr,
      shopId: shop._id.toString(),
      shopName: shop.name,
      shopSlug: shop.slug,
      ownerEmail: shop.ownerEmail,
      avatarUrl: shop.avatarUrl || picture,
      stationName: stationLabel,
      pricing: shop.pricing,
      printOptions: shop.printOptions,
      subscription: {
        plan: subInfo.subscription.plan,
        planName: subInfo.planConfig.name,
        monthlyOrderLimit: subInfo.planConfig.monthlyOrderLimit,
        ordersThisMonth: subInfo.subscription.ordersThisMonth,
        usagePercent: subInfo.usagePercent,
        isNearLimit: subInfo.isNearLimit,
        isLimitReached: subInfo.isLimitReached,
        canPrint: subInfo.canPrint,
        graceRemaining: subInfo.graceRemaining
      }
    });
  });

  // Alias /auth/google/verify
  fastify.post('/auth/google/verify', async (request, reply) => {
    return (fastify as any).inject({
      method: 'POST',
      url: '/api/auth/google',
      payload: request.body
    }).then((res: any) => {
      reply.code(res.statusCode).headers(res.headers).send(res.payload);
    });
  });
};
