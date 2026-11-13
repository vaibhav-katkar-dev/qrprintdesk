import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { buildApp } from '../src/server.js';
import { CONFIG } from '../src/config.js';
import { db, setSetting } from '../src/db.js';

describe('ShopPrint API & Integration Tests', () => {
  let app;

  before(async () => {
    CONFIG.PRINTER_MODE = 'mock';
    process.env.PRINTER_MODE = 'mock';
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('GET / returns 200 customer HTML', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/'
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /ShopPrint/);
  });

  test('GET /admin returns 200 admin HTML', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin'
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /ShopPrint - Shopkeeper Admin/);
  });

  test('Reject corrupt or invalid file format', async () => {
    // Attempt uploading a text file
    const boundary = '----WebKitFormBoundaryTest123';
    const body = 
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="bad.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n` +
      `THIS IS NOT A VALID PDF FILE CONTENT\r\n` +
      `--${boundary}--\r\n`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });

    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.payload);
    assert.match(json.error, /Magic bytes|corrupt|Invalid/i);
  });

  test('Successful PDF upload creates job with 4-digit code and token', async () => {
    // Generate valid 1-page PDF
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([300, 300]);
    const pdfBytes = await pdfDoc.save();

    const boundary = '----WebKitFormBoundaryValid123';
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="sample.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([header, Buffer.from(pdfBytes), footer]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    assert.equal(res.statusCode, 201);
    const json = JSON.parse(res.payload);
    assert.equal(json.success, true);
    assert.ok(json.code && json.code.length === 4);
    assert.ok(json.token);
    assert.equal(json.pageCount, 1);
  });

  test('Multiple documents upload combined into single print job', async () => {
    const pdfDoc1 = await PDFDocument.create();
    pdfDoc1.addPage([200, 200]);
    const pdfBytes1 = await pdfDoc1.save();

    const pdfDoc2 = await PDFDocument.create();
    pdfDoc2.addPage([200, 200]);
    pdfDoc2.addPage([200, 200]);
    const pdfBytes2 = await pdfDoc2.save();

    const boundary = '----WebKitFormBoundaryMultiTest';
    const part1 = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="doc1.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(pdfBytes1),
      Buffer.from('\r\n')
    ]);
    const part2 = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="doc2.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(pdfBytes2),
      Buffer.from('\r\n')
    ]);
    const fieldPart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="customer_name"\r\n\r\nCombined Tester\r\n`
    );
    const endPart = Buffer.from(`--${boundary}--\r\n`);
    const payload = Buffer.concat([part1, part2, fieldPart, endPart]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    assert.equal(res.statusCode, 201);
    const json = JSON.parse(res.payload);
    assert.equal(json.success, true);
    assert.equal(json.pageCount, 3); // 1 + 2 = 3 pages combined
    assert.match(json.originalFilename, /combined/i);
  });

  test('GET /api/config returns dynamic settings and pricing for customer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config'
    });
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.payload);
    assert.equal(typeof json.shopName, 'string');
    assert.equal(typeof json.allowDuplex, 'boolean');
    assert.equal(typeof json.allowColor, 'boolean');
    assert.equal(typeof json.allow2on1, 'boolean');
    assert.equal(typeof json.pricing.enabled, 'boolean');
  });

  test('Upload with 2-on-1 converts 2 pages into 1 physical sheet', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    pdf.addPage([200, 300]);
    const pdfBytes = await pdf.save();

    const boundary = '----WebKitFormBoundary2on1';
    const filePart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="two_pages.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    const nupField = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="pages_per_sheet"\r\n\r\n` +
      `2`
    );
    const endPart = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([filePart, Buffer.from(pdfBytes), nupField, endPart]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    assert.equal(res.statusCode, 201);
    const json = JSON.parse(res.payload);
    assert.equal(json.success, true);
    assert.equal(json.pageCount, 1); // 2 pages on 1 sheet = 1 sheet!
    assert.equal(json.pagesPerSheet, 2);
  });

  test('20 Concurrent Uploads handled reliably', async () => {
    // Clear out wait counts
    db.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE status IN ('UPLOADED', 'PENDING_APPROVAL', 'QUEUED')").run();

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([100, 100]);
    const pdfBytes = await pdfDoc.save();

    const boundary = '----WebKitFormBoundaryConcurrent';
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="concurrent.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([header, Buffer.from(pdfBytes), footer]);

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        app.inject({
          method: 'POST',
          url: '/api/jobs/upload',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'x-forwarded-for': `192.168.1.${i + 1}`
          },
          payload
        })
      );
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.statusCode, 201);
      const data = JSON.parse(r.payload);
      assert.ok(data.token);
    }
  });

  test('POST /api/admin/clear-all clears all jobs and storage', async () => {
    // Ensure known PIN
    const testPin = '9876';
    const { hashPin } = await import('../src/db.js');
    setSetting('admin_pin_hash', hashPin(testPin));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { pin: testPin }
    });

    const cookie = loginRes.headers['set-cookie'];

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-all',
      headers: {
        cookie: cookie ? (Array.isArray(cookie) ? cookie[0] : cookie) : ''
      }
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.payload);
    assert.equal(json.success, true);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get().cnt;
    assert.equal(remaining, 0);
  });

});

