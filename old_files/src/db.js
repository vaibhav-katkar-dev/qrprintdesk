import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from './config.js';

if (!fs.existsSync(CONFIG.DATA_DIR)) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// Support both better-sqlite3 (if native build present) and Node's built-in node:sqlite (zero-dependency, ultra-fast)
let rawDb;
let isNodeSqlite = false;

try {
  const { default: BetterSqlite } = await import('better-sqlite3');
  rawDb = new BetterSqlite(CONFIG.DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('synchronous = NORMAL');
} catch (e) {
  // Use built-in node:sqlite (Node 22+)
  const { DatabaseSync } = await import('node:sqlite');
  rawDb = new DatabaseSync(CONFIG.DB_PATH);
  rawDb.exec('PRAGMA journal_mode = WAL;');
  rawDb.exec('PRAGMA synchronous = NORMAL;');
  isNodeSqlite = true;
}

export const db = {
  exec(sql) {
    return rawDb.exec(sql);
  },
  prepare(sql) {
    const stmt = rawDb.prepare(sql);
    return {
      run(...args) {
        const res = stmt.run(...args);
        return {
          changes: res.changes,
          lastInsertRowid: typeof res.lastInsertRowid === 'bigint' ? Number(res.lastInsertRowid) : res.lastInsertRowid
        };
      },
      get(...args) {
        return stmt.get(...args);
      },
      all(...args) {
        return stmt.all(...args);
      }
    };
  },
  transaction(fn) {
    if (!isNodeSqlite && typeof rawDb.transaction === 'function') {
      return rawDb.transaction(fn);
    }
    return (...args) => {
      rawDb.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        rawDb.exec('COMMIT');
        return result;
      } catch (err) {
        rawDb.exec('ROLLBACK');
        throw err;
      }
    };
  }
};

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    client_ip TEXT,
    customer_name TEXT,
    original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    page_count INTEGER DEFAULT 0,
    copies INTEGER DEFAULT 1,
    color_mode TEXT DEFAULT 'monochrome',
    duplex_mode TEXT DEFAULT 'simplex',
    paper_size TEXT DEFAULT 'A4',
    fit_mode TEXT DEFAULT 'fit',
    customer_note TEXT DEFAULT '',
    status TEXT NOT NULL,
    failure_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    timestamp TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_token ON jobs(token);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
`);

// Safe column migrations for existing databases
try { db.exec("ALTER TABLE jobs ADD COLUMN paper_size TEXT DEFAULT 'A4';"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN fit_mode TEXT DEFAULT 'fit';"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN customer_note TEXT DEFAULT '';"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN orientation TEXT DEFAULT 'auto';"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN pages_per_sheet INTEGER DEFAULT 1;"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN page_range TEXT DEFAULT 'all';"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN estimated_price REAL DEFAULT 0;"); } catch {}

// Set default settings if not exists
const initSetting = (key, val) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, val);
  }
};

initSetting('auto_print', 'false');
initSetting('selected_printer', '');
initSetting('queue_paused', 'false');
initSetting('privacy_mode', 'false');
initSetting('default_paper_size', 'A4');
initSetting('default_fit_mode', 'fit');
initSetting('public_url', '');

// Customer option toggles & defaults
initSetting('allow_duplex', 'true');
initSetting('allow_color', 'true');
initSetting('allow_2on1', 'true');
initSetting('allow_orientation', 'true');
initSetting('allow_custom_pages', 'true');
initSetting('allow_copies', 'true');
initSetting('max_copies', '20');
initSetting('allow_paper_size', 'false');
initSetting('default_duplex', 'simplex');
initSetting('default_color', 'monochrome');
initSetting('shop_name', 'ShopPrint Station');
initSetting('enable_pricing', 'true');
initSetting('price_bw_per_page', '2.00');
initSetting('price_color_per_page', '10.00');
initSetting('price_duplex_discount', '0.50');

export const getSetting = (key, defaultVal = '') => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
};

export const setSetting = (key, val) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, String(val), String(val));
};

export const hashPin = (pin, salt = null) => {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

export const verifyPin = (pin, stored) => {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const newHash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(newHash, 'hex'));
};

export const generateJobCode = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

export const updateJobStatus = (jobId, toStatus, reason = '') => {
  const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  if (!job) return;
  const fromStatus = job.status;
  const now = new Date().toISOString();

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE jobs 
      SET status = ?, failure_reason = ?, updated_at = ? 
      WHERE id = ?
    `).run(toStatus, reason || null, now, jobId);

    db.prepare(`
      INSERT INTO job_history (job_id, from_status, to_status, reason, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, fromStatus, toStatus, reason || null, now);
  });

  update();
};

export const createAdminSession = (token) => {
  try {
    db.prepare('INSERT OR REPLACE INTO admin_sessions (token, created_at) VALUES (?, ?)').run(token, new Date().toISOString());
  } catch {}
};

export const verifyAdminSession = (token) => {
  if (!token) return false;
  try {
    const row = db.prepare('SELECT token FROM admin_sessions WHERE token = ?').get(token);
    return Boolean(row);
  } catch {
    return false;
  }
};

export const removeAdminSession = (token) => {
  if (!token) return;
  try {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  } catch {}
};
