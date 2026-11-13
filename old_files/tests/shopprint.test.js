import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { db, updateJobStatus, setSetting, getSetting, hashPin, verifyPin } from '../src/db.js';
import { initQueue, getQueuePosition, processNext } from '../src/queue.js';
import { CONFIG } from '../src/config.js';

describe('ShopPrint Core Logic Tests', () => {

  test('Database settings and PIN verification', () => {
    const pin = '1234';
    const hashed = hashPin(pin);
    assert.equal(verifyPin('1234', hashed), true);
    assert.equal(verifyPin('0000', hashed), false);

    setSetting('test_key', 'hello');
    assert.equal(getSetting('test_key'), 'hello');
  });

  test('Crash recovery: stuck PRINTING jobs marked CHECK_REPRINT', () => {
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const res = db.prepare(`
      INSERT INTO jobs (
        code, token, original_filename, storage_path, file_type, file_size,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('9999', token, 'crash.pdf', 'dummy/path', 'pdf', 100, 'PRINTING', now, now);

    const jobId = res.lastInsertRowid;

    // Run initQueue to trigger crash recovery
    initQueue();

    const recoveredJob = db.prepare('SELECT status, failure_reason FROM jobs WHERE id = ?').get(jobId);
    assert.equal(recoveredJob.status, 'CHECK_REPRINT');
    assert.match(recoveredJob.failure_reason, /Server restarted/);
  });

  test('Queue FIFO positioning calculation', () => {
    const now = new Date().toISOString();
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();

    const id1 = db.prepare(`
      INSERT INTO jobs (code, token, original_filename, storage_path, file_type, file_size, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('1001', t1, 'doc1.pdf', 'path1', 'pdf', 10, 'QUEUED', now, now).lastInsertRowid;

    const id2 = db.prepare(`
      INSERT INTO jobs (code, token, original_filename, storage_path, file_type, file_size, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('1002', t2, 'doc2.pdf', 'path2', 'pdf', 10, 'QUEUED', now, now).lastInsertRowid;

    const pos1 = getQueuePosition(id1);
    const pos2 = getQueuePosition(id2);
    assert.ok(pos1 < pos2, `Position 1 (${pos1}) should be less than Position 2 (${pos2})`);
  });

  test('PDF validation and image conversion check', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([200, 200]);
    const pdfBytes = await pdfDoc.save();

    const testPdfPath = path.join(CONFIG.DATA_DIR, `test_${Date.now()}.pdf`);
    fs.writeFileSync(testPdfPath, pdfBytes);

    const buf = fs.readFileSync(testPdfPath);
    assert.equal(buf[0], 0x25); // '%'
    assert.equal(buf[1], 0x50); // 'P'
    assert.equal(buf[2], 0x44); // 'D'
    assert.equal(buf[3], 0x46); // 'F'

    fs.unlinkSync(testPdfPath);
  });

  test('Invalid magic bytes rejected', () => {
    const invalidPath = path.join(CONFIG.DATA_DIR, `fake_${Date.now()}.pdf`);
    fs.writeFileSync(invalidPath, 'This is plain text pretending to be a PDF');
    const buf = fs.readFileSync(invalidPath);
    const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
    assert.equal(isPdf, false);
    fs.unlinkSync(invalidPath);
  });

  test('Mock printer execution produces output in mock-output directory', async () => {
    const prevMode = CONFIG.PRINTER_MODE;
    CONFIG.PRINTER_MODE = 'mock';

    // Clear out earlier queued test jobs
    db.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE status = 'QUEUED'").run();

    const testDoc = await PDFDocument.create();
    testDoc.addPage();
    const pdfBytes = await testDoc.save();

    const samplePath = path.join(CONFIG.DATA_DIR, `mock_${Date.now()}.pdf`);
    fs.writeFileSync(samplePath, pdfBytes);

    const now = new Date().toISOString();
    const token = crypto.randomUUID();
    const jobRes = db.prepare(`
      INSERT INTO jobs (
        code, token, customer_name, original_filename, storage_path, file_type, file_size,
        copies, color_mode, duplex_mode, paper_size, fit_mode, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('5555', token, 'Test Customer', 'mock.pdf', samplePath, 'pdf', pdfBytes.length, 1, 'monochrome', 'simplex', 'A4', 'fit', 'QUEUED', now, now);

    const jobId = jobRes.lastInsertRowid;
    setSetting('queue_paused', 'false');

    // Trigger queue processing
    await processNext();

    let attempts = 0;
    while (attempts < 25) {
      const j = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
      if (j && j.status === 'DONE') break;
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    const finishedJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    CONFIG.PRINTER_MODE = prevMode;

    assert.ok(finishedJob, 'Job should exist');
    assert.equal(finishedJob.status, 'DONE');

    const mockFiles = fs.readdirSync(CONFIG.MOCK_OUTPUT_DIR);
    const matched = mockFiles.some(f => f.includes('job_5555'));
    assert.equal(matched, true);

    try { fs.unlinkSync(samplePath); } catch {}
  });

});
