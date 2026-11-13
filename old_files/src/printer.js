import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { getPrinters } from './network.js';

const execFileAsync = promisify(execFile);

if (!fs.existsSync(CONFIG.MOCK_OUTPUT_DIR)) {
  fs.mkdirSync(CONFIG.MOCK_OUTPUT_DIR, { recursive: true });
}

export async function printJob(job, printerName) {
  const mode = CONFIG.PRINTER_MODE;

  if (mode === 'mock') {
    logger.info(`[MOCK PRINT] Simulating printing for Job #${job.code} to "${printerName || 'Default Mock'}"`);
    // Simulate printing delay
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Save copy to mock-output
    const targetFile = path.join(
      CONFIG.MOCK_OUTPUT_DIR,
      `job_${job.code}_${Date.now()}.pdf`
    );
    if (fs.existsSync(job.storage_path)) {
      fs.copyFileSync(job.storage_path, targetFile);
    }
    const metaFile = path.join(
      CONFIG.MOCK_OUTPUT_DIR,
      `job_${job.code}_${Date.now()}_meta.json`
    );
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          jobId: job.id,
          code: job.code,
          customerName: job.customer_name,
          printer: printerName || 'Default Mock',
          copies: job.copies,
          colorMode: job.color_mode,
          duplexMode: job.duplex_mode,
          paperSize: job.paper_size || 'A4',
          fitMode: job.fit_mode || 'fit',
          customerNote: job.customer_note || '',
          printedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    return { success: true };
  }

  // Strict guard against blank or ghost prints
  if (!job.storage_path || !fs.existsSync(job.storage_path)) {
    throw new Error(`Print file not found at ${job.storage_path || 'unknown'}. Aborted to prevent paper waste.`);
  }

  const fileStats = fs.statSync(job.storage_path);
  if (fileStats.size < 64) {
    throw new Error(`Print file is empty or too small (${fileStats.size} bytes). Aborted to prevent blank page print.`);
  }

  if (!job.page_count || job.page_count <= 0) {
    throw new Error(`Document has 0 pages registered. Aborted to prevent blank page print.`);
  }

  // Real mode: SumatraPDF
  if (!fs.existsSync(CONFIG.SUMATRA_PATH)) {
    throw new Error(
      `SumatraPDF executable not found at ${CONFIG.SUMATRA_PATH}. Please install or set PRINTER_MODE=mock.`
    );
  }

  // Pre-flight check: verify the printer is not offline before spooling
  if (printerName && printerName.trim()) {
    try {
      const printers = await getPrinters();
      const target = printers.find(p => p.name.toLowerCase() === printerName.trim().toLowerCase());
      if (target && target.isOffline) {
        throw new Error(`Printer "${printerName}" is OFFLINE / DISCONNECTED. Please turn on printer and check USB cable.`);
      }
    } catch (checkErr) {
      if (checkErr.message.includes('OFFLINE')) {
        throw checkErr;
      }
    }
  }

  const paper = job.paper_size || 'A4';
  const fit = job.fit_mode === 'noscale' ? 'noscale' : 'fit';
  const parts = [`${job.copies}x`, job.duplex_mode, job.color_mode, `paper=${paper}`, fit];
  // For 2-on-1 jobs the processed PDF is already A4 landscape — do NOT pass orientation
  // to SumatraPDF or it will force-rotate/clip the landscape sheet causing blank prints.
  const is2on1 = job.pages_per_sheet === 2 || job.pages_per_sheet === '2';
  if (!is2on1 && job.orientation && ['portrait', 'landscape'].includes(job.orientation)) {
    parts.push(job.orientation);
  }
  const printSettings = parts.join(',');
  
  const args = [];
  if (printerName && printerName.trim()) {
    args.push('-print-to', printerName.trim());
  } else {
    args.push('-print-to-default');
  }
  args.push('-silent', '-print-settings', printSettings, job.storage_path);

  logger.info({ args, printer: printerName || 'Default' }, 'Executing SumatraPDF print command');

  try {
    const { stdout, stderr } = await execFileAsync(CONFIG.SUMATRA_PATH, args, {
      timeout: 45000 // 45 seconds timeout
    });
    return { success: true, stdout, stderr };
  } catch (err) {
    logger.error({ err }, 'SumatraPDF print failed');
    throw new Error(`Print failed: ${err.message || 'SumatraPDF execution error'}`);
  }
}
