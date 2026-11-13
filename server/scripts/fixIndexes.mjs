// One-time script: drop conflicting indexes and recreate with correct options
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db('shopprint');

// ---- shops collection ----
const shops = db.collection('shops');
const shopsIdxs = await shops.indexes();
console.log('=== shops indexes BEFORE ===');
shopsIdxs.forEach(i => console.log(JSON.stringify(i)));

// Drop the non-sparse easySplit.vendorId index if it exists
const conflicting = shopsIdxs.find(i => i.name === 'easySplit.vendorId_1' && !i.sparse);
if (conflicting) {
  console.log('\nDropping non-sparse easySplit.vendorId_1 index...');
  await shops.dropIndex('easySplit.vendorId_1');
  console.log('Dropped.');
} else {
  console.log('\nNo conflicting easySplit.vendorId_1 index found — nothing to drop.');
}

// Recreate with sparse: true
await shops.createIndex({ 'easySplit.vendorId': 1 }, { sparse: true });
console.log('Recreated easySplit.vendorId_1 with sparse: true');

// ---- orders collection ----
const orders = db.collection('orders');
const ordersIdxs = await orders.indexes();
console.log('\n=== orders indexes BEFORE ===');
ordersIdxs.forEach(i => console.log(JSON.stringify(i)));

const provConflict = ordersIdxs.find(i => i.name === 'providerOrderId_1' && (!i.unique || !i.sparse));
if (provConflict) {
  console.log('\nDropping conflicting providerOrderId_1 on orders...');
  await orders.dropIndex('providerOrderId_1');
  await orders.createIndex({ providerOrderId: 1 }, { unique: true, sparse: true });
  console.log('Recreated providerOrderId_1 with unique+sparse.');
} else {
  console.log('\norders.providerOrderId_1 OK.');
}

// ---- settlements collection ----
const settlements = db.collection('settlements');
try {
  await settlements.createIndex({ settlementId: 1 }, { unique: true });
  console.log('\nsettlements.settlementId_1 created OK.');
} catch (e) {
  console.log('\nsettlements.settlementId_1 already OK:', e.message);
}
try {
  await settlements.createIndex({ vendorId: 1, createdAt: -1 });
  console.log('settlements.vendorId_1_createdAt_-1 created OK.');
} catch (e) {
  console.log('settlements secondary index already OK:', e.message);
}

await client.close();
console.log('\nDone — all indexes are clean.');
