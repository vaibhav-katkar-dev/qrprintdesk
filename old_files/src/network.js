import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { Bonjour } from 'bonjour-service';
import { logger } from './logger.js';
import { CONFIG } from './config.js';

const execAsync = promisify(exec);

export function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, list] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        let score = 0;
        // Prioritize actual physical Wi-Fi or Wireless adapters
        if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
          score += 100;
        } else if (lowerName === 'ethernet' || lowerName.startsWith('local area connection')) {
          score += 50;
        }

        // Heavily penalize virtual adapters (Hyper-V, WSL, VMware, VirtualBox, Docker)
        if (
          lowerName.includes('vethernet') ||
          lowerName.includes('virtual') ||
          lowerName.includes('vmware') ||
          lowerName.includes('vbox') ||
          lowerName.includes('wsl') ||
          lowerName.includes('docker')
        ) {
          score -= 200;
        }

        // Standard local LAN subnets
        if (iface.address.startsWith('192.168.')) score += 20;
        else if (iface.address.startsWith('10.')) score += 10;

        candidates.push({ address: iface.address, score });
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].address;
  }

  return '127.0.0.1';
}

let bonjourInstance = null;
let bonjourService = null;

export function startBonjourService(port) {
  try {
    bonjourInstance = new Bonjour();
    bonjourService = bonjourInstance.publish({
      name: 'ShopPrint',
      type: 'http',
      port: port,
      host: 'shopprint.local'
    });
    bonjourService.on('error', (err) => {
      logger.warn({ err }, 'mDNS service error (falling back to direct IP)');
    });
    logger.info(`mDNS broadcast active: shopprint.local (port ${port})`);
  } catch (err) {
    logger.warn({ err }, 'Could not start Bonjour mDNS service');
  }
}

export function stopBonjourService() {
  if (bonjourService) {
    try {
      bonjourService.stop();
    } catch {}
  }
  if (bonjourInstance) {
    try {
      bonjourInstance.destroy();
    } catch {}
  }
}

let cachedPrinters = null;
let lastPrintersQuery = 0;

export async function getPrinters() {
  const now = Date.now();
  if (cachedPrinters && (now - lastPrintersQuery < 6000)) {
    return cachedPrinters;
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object -Property Name, Default, PrinterStatus, WorkOffline | ConvertTo-Json -Compress"',
        { timeout: 10000 }
      );
      if (!stdout || !stdout.trim()) {
        cachedPrinters = [{ name: 'Default Printer', isDefault: true, isOffline: false, status: 'Ready' }];
        lastPrintersQuery = now;
        return cachedPrinters;
      }
      let parsed = JSON.parse(stdout.trim());
      if (!Array.isArray(parsed)) {
        parsed = [parsed];
      }
      cachedPrinters = parsed.map((p) => ({
        name: p.Name,
        isDefault: Boolean(p.Default),
        isOffline: Boolean(p.WorkOffline),
        status: p.WorkOffline ? 'Offline' : 'Ready'
      }));
      lastPrintersQuery = now;
      return cachedPrinters;
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to query Windows printers via PowerShell');
      if (cachedPrinters) return cachedPrinters;
    }
  }

  return [
    { name: 'Mock Virtual Printer', isDefault: true, isOffline: false, status: 'Ready' }
  ];
}

export function checkFreeDiskMB() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(CONFIG.ROOT_DIR);
      const freeBytes = stats.bavail * stats.bsize;
      return Math.floor(freeBytes / (1024 * 1024));
    }
  } catch (err) {
    logger.warn({ err }, 'statfsSync failed, checking with fallback');
  }
  return 1024; // assume healthy if unreadable
}
