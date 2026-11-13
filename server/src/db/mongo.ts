import { MongoClient, Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  // 1. shops
  await db.collection('shops').createIndex({ slug: 1 }, { unique: true });

  // 2. agents
  await db.collection('agents').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('agents').createIndex({ shopId: 1, isRevoked: 1 });

  // 3. orders
  await db.collection('orders').createIndex({ orderId: 1 }, { unique: true });
  await db.collection('orders').createIndex({ shopId: 1, status: 1, createdAt: -1 });
  await db.collection('orders').createIndex({ providerOrderId: 1 }, { unique: true, sparse: true });
  await db.collection('orders').createIndex({ retentionUntil: 1 });

  // 4. jobs
  await db.collection('jobs').createIndex({ jobId: 1 }, { unique: true });
  await db.collection('jobs').createIndex({ shopId: 1, status: 1, createdAt: 1 });
  await db.collection('jobs').createIndex({ orderId: 1 });

  // 5. payments
  await db.collection('payments').createIndex({ providerOrderId: 1, providerEventId: 1 }, { unique: true, sparse: true });
  await db.collection('payments').createIndex({ orderId: 1 });

  // 6. ledger
  await db.collection('ledger').createIndex({ orderId: 1 }, { unique: true });
  await db.collection('ledger').createIndex({ shopId: 1, createdAt: -1 });

  // 7. outbox
  await db.collection('outbox').createIndex({ status: 1, nextAttemptAt: 1, _id: 1 });
  await db.collection('outbox').createIndex({ jobId: 1 });

  // 8. idempotencyKeys
  await db.collection('idempotencyKeys').createIndex({ key: 1, scope: 1 }, { unique: true });
  await db.collection('idempotencyKeys').createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 7 });

  // 9. settlements (Easy Split Webhook & Payout Ledger)
  await db.collection('settlements').createIndex({ settlementId: 1 }, { unique: true });
  await db.collection('settlements').createIndex({ vendorId: 1, createdAt: -1 });

  // 10. Easy Split vendor lookup in shops
  await db.collection('shops').createIndex({ 'easySplit.vendorId': 1 }, { sparse: true });
}

export async function initMongo(uri: string, dbName: string = 'QrPrintDesk'): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(uri, {
    maxPoolSize: 50,
    minPoolSize: 5
  });
  await client.connect();
  const database = client.db(dbName);
  await ensureIndexes(database);
  return { client, db: database };
}
