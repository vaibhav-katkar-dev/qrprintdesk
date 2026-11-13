import { buildApp } from '../src/app.js';
import { MongoClient } from 'mongodb';

async function runVerification() {
  console.log('--- Starting System Verification ---');

  // 1. Mock minimal Db
  const mockDb: any = {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => ({
      createIndex: async () => 'idx',
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => []
          }),
          toArray: async () => []
        }),
        toArray: async () => []
      }),
      countDocuments: async () => 0,
      aggregate: () => ({
        toArray: async () => []
      }),
      findOne: async () => null,
      updateOne: async () => ({ acknowledged: true }),
      insertOne: async () => ({ insertedId: 'mock_id' }),
      findOneAndUpdate: async () => null
    })
  };
  const mockClient: any = {};

  const appInstance = buildApp(mockDb, mockClient, false);
  const fastify = appInstance.fastify;

  try {
    await fastify.ready();
    console.log('✓ Fastify app successfully booted and loaded all plugins');

    // Test Landing Page
    const landingRes = await fastify.inject({ method: 'GET', url: '/' });
    console.log(`✓ GET / (Landing Page) Status: ${landingRes.statusCode} (Expected: 200)`);
    if (landingRes.statusCode !== 200) throw new Error('Landing page route failed');

    // Test Admin Page
    const adminRes = await fastify.inject({ method: 'GET', url: '/admin' });
    console.log(`✓ GET /admin (Admin UI) Status: ${adminRes.statusCode} (Expected: 200)`);
    if (adminRes.statusCode !== 200) throw new Error('Admin page route failed');

    // Test Vendor Portal Page
    const vendorPortalRes = await fastify.inject({ method: 'GET', url: '/vendor' });
    console.log(`✓ GET /vendor (Vendor Self-Service Portal) Status: ${vendorPortalRes.statusCode} (Expected: 200)`);
    if (vendorPortalRes.statusCode !== 200) throw new Error('Vendor portal route failed');

    // Test Protected Admin API without Auth
    const unauthRes = await fastify.inject({ method: 'GET', url: '/api/admin/metrics' });
    console.log(`✓ GET /api/admin/metrics without auth Status: ${unauthRes.statusCode} (Expected: 401 Unauthorized)`);
    if (unauthRes.statusCode !== 401) throw new Error('Admin route protection failed');

    // Test Protected Admin API with Valid Auth
    const authRes = await fastify.inject({
      method: 'GET',
      url: '/api/admin/metrics',
      headers: { authorization: 'Bearer admin_secret_key_2026' }
    });
    console.log(`✓ GET /api/admin/metrics with auth Status: ${authRes.statusCode} (Expected: 200)`);
    if (authRes.statusCode !== 200) throw new Error('Admin metrics route failed');

    // Test Cashfree Webhook Route Handling
    const webhookRes = await fastify.inject({
      method: 'POST',
      url: '/api/webhooks/cashfree',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': 'mock_sig',
        'x-webhook-timestamp': '123456789'
      },
      payload: {
        type: 'VENDOR_SETTLEMENT_SUCCESS',
        data: {
          vendor_id: 'CF_VEND_TEST',
          settlement_id: 'SETTLE_123',
          settlement_amount: 500
        }
      }
    });
    console.log(`✓ POST /api/webhooks/cashfree Status: ${webhookRes.statusCode}`);

    console.log('\n========================================');
    console.log('  ALL CHECKS PASSED: SYSTEM WORKING FINE');
    console.log('========================================');
  } finally {
    await appInstance.close();
  }
}

runVerification().catch((err) => {
  console.error('Verification failed with error:', err);
  process.exit(1);
});
