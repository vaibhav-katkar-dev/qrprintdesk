import autocannon from 'autocannon';
import { PDFDocument } from 'pdf-lib';
import { buildApp } from '../src/server.js';
import { db } from '../src/db.js';

async function runLoadTest() {
  process.stdout.write('Setting up ShopPrint server for load test...\n');

  // Cancel any lingering queued test jobs
  db.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE status IN ('UPLOADED', 'PENDING_APPROVAL', 'QUEUED')").run();

  const app = await buildApp();
  await app.listen({ port: 3099, host: '127.0.0.1' });
  process.stdout.write('Test server running on port 3099\n');

  // Create valid sample PDF
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([150, 150]);
  const pdfBytes = await pdfDoc.save();

  const boundary = '----WebKitFormBoundaryLoadTest';
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="loadtest.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, Buffer.from(pdfBytes), footer]);

  process.stdout.write('Running Autocannon: 30 concurrent requests...\n');

  let ipCounter = 1;
  const result = await autocannon({
    url: 'http://127.0.0.1:3099/api/jobs/upload',
    connections: 10,
    amount: 30,
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    body,
    setupClient: (client) => {
      client.setHeaders({
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-forwarded-for': `10.0.1.${(ipCounter++ % 200) + 1}`
      });
    }
  });

  process.stdout.write('====================================\n');
  process.stdout.write(`Autocannon 30 Uploads Result:\n`);
  process.stdout.write(`Total requests completed: ${result.requests.total}\n`);
  process.stdout.write(`2xx Success responses:   ${result['2xx']}\n`);
  process.stdout.write(`Non-2xx responses:       ${result.non2xx}\n`);
  process.stdout.write(`Avg latency:             ${result.latency.average} ms\n`);
  process.stdout.write(`Throughput:              ${result.throughput.average} bytes/s\n`);
  process.stdout.write('====================================\n');

  await app.close();
  process.exit(0);
}

runLoadTest().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
