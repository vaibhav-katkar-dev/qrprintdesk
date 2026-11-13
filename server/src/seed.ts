/**
 * seed.ts  â€“  Run once before first launch to create a default shop + agent token.
 * Usage:  npx tsx src/seed.ts
 * This is idempotent: running it twice does NOT duplicate data.
 */
import dotenv from 'dotenv';
dotenv.config();

import crypto from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME   = process.env.DB_NAME   || 'QrPrintDesk';

// Fixed dev token â€“ matches what windows-software/src/db.js seeds into SQLite
const DEV_AGENT_TOKEN = 'QrPrintDesk_agent_token_dev';
const DEV_PIN         = '1234';  // shop login pin

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // 1. Upsert default shop
  const pinHash = sha256(DEV_PIN);
  const shopSlug = 'default';
  const now = new Date();

  const shopResult = await db.collection('shops').findOneAndUpdate(
    { slug: shopSlug },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        name: 'QrPrintDesk Local Dev',
        slug: shopSlug,
        ownerEmail: 'dev@QrPrintDesk.local',
        pinHash,
        pricing: {
          bwPerPagePaise: 200,       // â‚¹2.00
          colorPerPagePaise: 1000,   // â‚¹10.00
          duplexDiscountPaise: 50    // â‚¹0.50
        },
        isActive: true,
        createdAt: now,
        updatedAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  const shop = shopResult?.value ?? await db.collection('shops').findOne({ slug: shopSlug });
  const shopId = shop!._id as ObjectId;

  console.log(`\nâœ… Shop: "${shop!.name}" (slug="${shopSlug}", id=${shopId})`);
  console.log(`   Login:  POST /api/auth/shop/login  { shopSlug: "${shopSlug}", pin: "${DEV_PIN}" }`);

  // 2. Upsert dev agent token
  const tokenHash = sha256(DEV_AGENT_TOKEN);

  const existing = await db.collection('agents').findOne({ tokenHash });
  if (existing) {
    console.log(`\nâœ… Agent token already exists (id=${existing._id})`);
  } else {
    const agentDoc = {
      _id: new ObjectId(),
      shopId,
      name: 'Windows Station (Dev)',
      tokenHash,
      isRevoked: false,
      createdAt: now,
      updatedAt: now
    };
    await db.collection('agents').insertOne(agentDoc);
    console.log(`\nâœ… Agent token created  (id=${agentDoc._id})`);
  }

  console.log(`\n   Token value stored in windows-software SQLite: "${DEV_AGENT_TOKEN}"`);
  console.log(`   (This token is for LOCAL DEVELOPMENT only. Create a real token before going live.)\n`);

  await client.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
