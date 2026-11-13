import autocannon from 'autocannon';
import { PDFDocument } from 'pdf-lib';

// Configuration profiles for simulation
const PROFILES = {
  avg: {
    name: 'Average Load (Typical Busy Store)',
    connections: 15,
    duration: 10,
    pipelining: 1,
    uploadConcurrency: 5,
    totalUploads: 20
  },
  worst: {
    name: 'Worst Case / Stress Spike (College/Exam Rush)',
    connections: 75,
    duration: 20,
    pipelining: 2,
    uploadConcurrency: 20,
    totalUploads: 60
  }
};

// Parse command line arguments
// Example: node scripts/load_simulator.js --mode=avg --target=https://okinsite.com
const args = process.argv.slice(2);
const modeArg = args.find(a => a.startsWith('--mode='))?.split('=')[1]?.toLowerCase() || 'avg';
const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1] || 'https://okinsite.com';
const selectedProfile = PROFILES[modeArg] || PROFILES.avg;
const BASE_URL = targetArg.replace(/\/+$/, '');

console.log('\n============================================================');
console.log(`  SHOPPRINT LOAD TESTING & STRESS SIMULATION`);
console.log('============================================================');
console.log(`  Target Server:  ${BASE_URL}`);
console.log(`  Profile Mode:   ${modeArg.toUpperCase()} -> ${selectedProfile.name}`);
console.log(`  Concurrency:    ${selectedProfile.connections} connections`);
console.log(`  Test Duration:  ${selectedProfile.duration} seconds`);
console.log('============================================================\n');

/**
 * Generate a valid multi-page PDF in memory
 */
async function generateSamplePdf(pageCount = 2) {
  const pdfDoc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.addPage([400, 600]);
    page.drawText(`ShopPrint Simulation Document - Page ${i + 1}`, { x: 50, y: 550 });
  }
  return Buffer.from(await pdfDoc.save());
}

/**
 * Stage 1: API & Web Traffic Load Test (autocannon)
 */
async function runWebLoadTest() {
  console.log(`[Stage 1/2] Running HTTP Traffic Simulation (${selectedProfile.connections} concurrent users)...`);

  const result = await autocannon({
    url: `${BASE_URL}/health`,
    connections: selectedProfile.connections,
    duration: selectedProfile.duration,
    pipelining: selectedProfile.pipelining,
    requests: [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/' }
    ]
  });

  console.log('\n--- Stage 1: HTTP Traffic Results ---');
  console.log(`  Total Requests:       ${result.requests.total}`);
  console.log(`  Requests / Sec (RPS): ${result.requests.average} req/s`);
  console.log(`  2xx Successes:        ${result['2xx']}`);
  console.log(`  Errors / Non-2xx:     ${result.non2xx + result.errors}`);
  console.log(`  Avg Latency:          ${result.latency.average} ms`);
  console.log(`  p95 Latency:          ${result.latency.p97_5 || result.latency.p90} ms`);
  console.log(`  p99 Latency:          ${result.latency.p99} ms`);
  console.log(`  Throughput:           ${(result.throughput.average / 1024).toFixed(2)} KB/s`);
  return result;
}

/**
 * Stage 2: Direct Document Upload Simulation (Real multipart upload to Cloud Storage)
 */
async function runUploadSimulation() {
  console.log(`\n[Stage 2/2] Running Document Upload Simulation (${selectedProfile.totalUploads} uploads)...`);

  const pdfBytes = await generateSamplePdf(2);

  let successful = 0;
  let failed = 0;
  const latencies = [];

  const queue = Array.from({ length: selectedProfile.totalUploads }, (_, i) => i + 1);

  async function worker(workerId) {
    while (queue.length > 0) {
      queue.shift();
      const start = Date.now();
      try {
        const form = new FormData();
        form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), `sim_doc_${workerId}.pdf`);
        form.append('shopSlug', 'default');

        const res = await fetch(`${BASE_URL}/api/uploads/direct`, {
          method: 'POST',
          body: form
        });
        const elapsed = Date.now() - start;
        latencies.push(elapsed);

        if (res.status === 200 || res.status === 201) {
          successful++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
      }
    }
  }

  const workers = Array.from({ length: selectedProfile.uploadConcurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : 0;
  latencies.sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  console.log('\n--- Stage 2: Document Upload Results ---');
  console.log(`  Uploads Executed:     ${selectedProfile.totalUploads}`);
  console.log(`  Completed (201/200):  ${successful}`);
  console.log(`  Failed / Errors:      ${failed}`);
  console.log(`  Avg Upload Latency:   ${avgLatency} ms`);
  console.log(`  p95 Upload Latency:   ${p95} ms`);
}

async function main() {
  try {
    const webResult = await runWebLoadTest();
    await runUploadSimulation();

    console.log('\n============================================================');
    console.log('  SIMULATION SUMMARY & ANALYSIS');
    console.log('============================================================');
    if (webResult.errors === 0 && webResult.latency.average < 500) {
      console.log('  Status: [PASS] Server handled traffic smoothly under target load.');
    } else if (webResult.latency.average < 1500) {
      console.log('  Status: [FAIR] Server responded but latency increased under stress.');
    } else {
      console.log('  Status: [WARN] High latency or errors detected. Check CPU/RAM & DB.');
    }
    console.log('============================================================\n');
  } catch (err) {
    console.error('Fatal load simulation error:', err);
    process.exit(1);
  }
}

main();
