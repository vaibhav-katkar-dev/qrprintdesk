import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { buildApp, AppInstance } from '../src/app.js';

describe('Vendor Management & API Endpoints', () => {
  let mongoClient: MongoClient;
  let db: Db;
  let app: AppInstance;
  let agentToken: string;
  let shopSlug: string;

  beforeAll(async () => {
    mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
    await mongoClient.connect();
    db = mongoClient.db('shopprint_test_vendor_suite');
    app = buildApp(db, mongoClient, false);
    await app.fastify.ready();
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (app) await app.close();
    if (mongoClient) await mongoClient.close();
  });

  it('registers a new vendor shop and returns agent credentials', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/vendor/register',
      payload: {
        shopName: 'Metro Print Station',
        ownerEmail: 'metro@example.com',
        pin: '5432',
        stationName: 'Counter 1'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.agentToken).toBeDefined();
    expect(body.shopName).toBe('Metro Print Station');
    expect(body.shopSlug).toContain('metro-print-station');
    expect(body.ownerEmail).toBe('metro@example.com');
    expect(body.stationName).toBe('Counter 1');

    agentToken = body.agentToken;
    shopSlug = body.shopSlug;
  });

  it('rejects registration with invalid email or short pin', async () => {
    const badEmail = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/vendor/register',
      payload: {
        shopName: 'Bad Shop',
        ownerEmail: 'notanemail',
        pin: '1234',
        stationName: 'Counter'
      }
    });
    expect(badEmail.statusCode).toBe(400);

    const badPin = await app.fastify.inject({
      method: 'POST',
      url: '/api/auth/vendor/register',
      payload: {
        shopName: 'Bad Shop',
        ownerEmail: 'test@example.com',
        pin: '12',
        stationName: 'Counter'
      }
    });
    expect(badPin.statusCode).toBe(400);
  });

  it('retrieves vendor dashboard statistics using agent token', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/vendor/dashboard',
      headers: { authorization: `Bearer ${agentToken}` }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.shop.name).toBe('Metro Print Station');
    expect(body.stats).toBeDefined();
    expect(typeof body.stats.totalOrders).toBe('number');
    expect(typeof body.stats.pendingJobs).toBe('number');
  });

  it('updates vendor shop settings and pricing', async () => {
    const res = await app.fastify.inject({
      method: 'PUT',
      url: '/api/vendor/settings',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        shopName: 'Metro Print Express',
        bwPerPagePaise: 200,
        colorPerPagePaise: 700
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.shop.name).toBe('Metro Print Express');
    expect(body.shop.pricing.bwPerPagePaise).toBe(200);
    expect(body.shop.pricing.colorPerPagePaise).toBe(700);
  });

  it('retrieves vendor jobs with pagination', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/vendor/jobs?limit=10',
      headers: { authorization: `Bearer ${agentToken}` }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
  });

  it('generates a QR code data URL for the registered shop', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: `/api/shops/${shopSlug}/qr`
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(body.shopUrl).toContain(shopSlug);
  });
});
