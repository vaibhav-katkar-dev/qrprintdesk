// QrPrintDesk Vendor Desktop  renderer.js
// Modern SaaS UI v2.0.0
'use strict';

let config = null;
let ws = null;
let wsReconnectTimer = null;
let dashboardPollTimer = null;
let audioCtx = null;
let currentRejectJobId = null;
let currentJobModalId = null;
let allFetchedJobs = [];
let currentFilter = 'all';
let currentSearchQuery = '';

// ── FIFO Print Queue ────────────────────────────────────────────────────────
// Guarantees jobs are printed one-at-a-time in arrival order.
// Multiple simultaneous WebSocket jobs are queued, never run in parallel.
const _printQueue = [];
let _isPrinting = false;

function enqueuePrintJob(jobId) {
  _printQueue.push(jobId);
  _flushPrintQueue();
}

async function _flushPrintQueue() {
  if (_isPrinting || _printQueue.length === 0) return;
  _isPrinting = true;
  const jobId = _printQueue.shift();
  try {
    await _executePrintJob(jobId);
  } catch (e) {
    console.error('[PrintQueue] Job failed:', jobId, e);
  } finally {
    _isPrinting = false;
    _flushPrintQueue(); // process next job immediately
  }
}

async function _executePrintJob(jobId) {
  const shortId = jobId.substring(0, 8);

  // ── Pre-flight: check printer is ready before downloading ─────────────────
  const printers = await window.electronAPI.getPrinters().catch(() => []);
  const selectedName = (config.printerName || '').toLowerCase();
  const target = printers.find(p =>
    selectedName ? p.name.toLowerCase() === selectedName : p.isDefault
  ) || printers[0];

  if (target && target.status && target.status.toLowerCase().includes('offline')) {
    // Printer offline → hold job in queue tail, alert shopkeeper
    logPrinterActivity(`[HOLD] Printer offline — Job #${shortId} re-queued`, 'orange');
    showToast(`Printer offline: Job #${shortId} held — connect printer to auto-resume.`, 'error');
    _printQueue.unshift(jobId); // push back to front
    _isPrinting = false;
    // Retry automatically in 10 seconds
    setTimeout(() => _flushPrintQueue(), 10_000);
    return;
  }

  // ── Download & spool ───────────────────────────────────────────────────────
  logPrinterActivity(`[QUEUE] Starting job #${shortId} (${_printQueue.length} remaining after this)`, 'blue');
  const meta = await _getJobDownloadMeta(jobId);
  const downloadUrls = meta.files.map(f => ({
    url: f.downloadUrl,
    filename: f.originalFilename,
    pageRange: f.pageRange,
    copies: f.copies,
    colorMode: f.colorMode
  }));
  const r = await window.electronAPI.printJob({ jobId, downloadUrls, printOptions: meta.printOptions });

  if (r.success) {
    showToast(`Job #${shortId} printed successfully`, 'success');
    logPrinterActivity(`[DONE] Job #${shortId} printed successfully`, 'green');
  } else {
    showToast(`Print issue on #${shortId}: ${r.error || 'Check printer'}`, 'error');
    logPrinterActivity(`[FAIL] Job #${shortId}: ${r.error || 'Device busy'}`, 'red');
  }
  invalidateCache('jobs', 'dashboard');
  refreshDashboard(true);
}

// ── Status badge helper ─────────────────────────────────────────────────────
// Returns a badge <span> with a colored pulsing dot for every known job state.
const STATUS_META = {
  queued:                 { dot: '#f59e0b', pulse: true,  label: 'Queued'        },
  pay_at_counter_pending: { dot: '#eab308', pulse: true,  label: 'Pay at Counter'},
  downloading:            { dot: '#8b5cf6', pulse: true,  label: 'Downloading'   },
  print_submitted:  { dot: '#3b82f6', pulse: true,  label: 'Submitted'     },
  printing:         { dot: '#3b82f6', pulse: true,  label: 'Printing'      },
  completed:        { dot: '#16a34a', pulse: false, label: 'Completed'     },
  failed:           { dot: '#ef4444', pulse: false, label: 'Failed'        },
  rejected:         { dot: '#dc2626', pulse: false, label: 'Rejected'      },
  cancelled:        { dot: '#94a3b8', pulse: false, label: 'Cancelled'     },
  waiting_printer:  { dot: '#f97316', pulse: true,  label: 'Printer Hold'  },
  printer_offline:  { dot: '#dc2626', pulse: true,  label: 'Printer Off'   },
};

function statusBadgeHtml(rawStatus) {
  const key = (rawStatus || '').toLowerCase().replace(/ /g, '_');
  const meta = STATUS_META[key] || { dot: '#94a3b8', pulse: false, label: rawStatus || '-' };
  const dotClass = meta.pulse ? 'status-indicator-dot pulse' : 'status-indicator-dot';
  return `<span class="badge ${key}">` +
    `<span class="${dotClass}" style="background:${meta.dot};box-shadow:0 0 0 2px ${meta.dot}22;"></span>` +
    `${meta.label}` +
    `</span>`;
}

//  API Cache (stale-while-revalidate) 
// Avoids redundant network calls for the same data within a short window.
// Each key stores { data, ts } where ts is the timestamp of last fetch.
const _apiCache = new Map();
const CACHE_TTL = {
  jobs:       30_000,   // 30 s   jobs list
  dashboard:  20_000,   // 20 s   stats & shop info
  settings:  300_000,   // 5 min  shop settings (rarely changes)
  easysplit: 300_000,   // 5 min  bank/split config
  dlurl:      55_000,   // 55 s   presigned download URL (B2 URLs expire in 60 s)
};

/**
 * Fetch with in-memory TTL cache + stale-while-revalidate.
 * @param {string} cacheKey  - Unique key (e.g. 'jobs', 'dashboard', 'dlurl:<jobId>')
 * @param {string} url       - Full URL to fetch
 * @param {object} opts      - fetch() options (headers etc.)
 * @param {number} ttl       - TTL in ms (from CACHE_TTL)
 * @param {boolean} [force]  - Bypass cache and force a fresh fetch
 */
async function apiFetch(cacheKey, url, opts, ttl, force = false) {
  const now = Date.now();
  const cached = _apiCache.get(cacheKey);

  // Return cached data instantly if still fresh
  if (!force && cached && (now - cached.ts) < ttl) {
    return cached.data;
  }

  // Fetch fresh data
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  _apiCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

/** Invalidate one or more cache keys (call after mutations like status changes) */
function invalidateCache(...keys) {
  keys.forEach(k => _apiCache.delete(k));
}

//  Init 
window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.message, e.filename, e.lineno);
});

window.addEventListener('DOMContentLoaded', async () => {
  console.log('Renderer: DOMContentLoaded fired');
  setupNavigation();
  setupEventListeners();

  try {
    config = await window.electronAPI.getConfig();
    console.log('Renderer: config loaded:', JSON.stringify(config));
  } catch (err) {
    console.error('Renderer: getConfig error:', err);
  }

  if (!config || !config.agentToken) {
    console.log('Renderer: showing setup modal');
    showSetupModal(true);
  } else {
    console.log('Renderer: applying config and connecting');
    applyConfigUI();
    initWebSocket();
    refreshDashboard();
    loadPrinters();
    loadQR();
    startDashboardPolling();
    // Real-time continuous printer status check (every 4 seconds)
    setInterval(loadPrinters, 4000);
  }
});

//  Navigation 
function setupNavigation() {
  const navItems  = document.querySelectorAll('.nav-item');
  const pages     = document.querySelectorAll('.page');
  const pageTitle = document.getElementById('page-title');
  const pageSub   = document.getElementById('page-sub');

  const titles = {
    dashboard:    { title: 'Print Queue',        sub: 'Live incoming customer print requests' },
    jobs:         { title: 'Order History',      sub: 'Search, filter, and reprint previous customer orders' },
    analytics:    { title: 'Shop Analytics',     sub: 'Footfall patterns, peak rush hours, and page velocity' },
    finances:     { title: 'Bank & Settlements', sub: 'Revenue analytics, ledger transactions, and automated payouts' },
    qr:           { title: 'Counter QR Standee', sub: 'Counter standee QR code and direct store link' },
    settings:     { title: 'Station Settings',   sub: 'Printer hardware, per-page rates, and checkout options' },
    subscription: { title: 'Billing & Limits',   sub: 'Monthly print allowance, active tier, and plan upgrade' },
    support:      { title: 'Station Helpdesk',   sub: 'Direct support, diagnostic tools, and spooler checks' }
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-page');
      if (!target) return; // e.g. logout button

      navItems.forEach(n => n.classList.remove('active'));
      pages.forEach(p => p.classList.remove('active'));

      item.classList.add('active');

      if (target === 'analytics') {
        const pageEl = document.getElementById('page-finances');
        if (pageEl) pageEl.classList.add('active');
        switchFinSubTab('analytics');
      } else {
        const pageEl = document.getElementById(`page-${target}`);
        if (pageEl) pageEl.classList.add('active');
      }

      if (titles[target]) {
        pageTitle.innerText = titles[target].title;
        pageSub.innerText   = titles[target].sub;
      }

      if (target === 'dashboard') refreshDashboard();
      if (target === 'jobs')      loadAllJobs();
      if (target === 'analytics') loadAnalytics(currentAnalyticsPeriod);
      if (target === 'finances')  loadFinancesPage();
      if (target === 'qr')           loadQR();
      if (target === 'settings')     loadSettingsFromServer();
      if (target === 'subscription') loadSubscriptionFromServer();
    });
  });
}

//  Event Listeners 
function setupEventListeners() {
  document.getElementById('refresh-btn').addEventListener('click', () => {
    refreshDashboard();
    const jobPage = document.getElementById('page-jobs');
    if (jobPage && jobPage.classList.contains('active')) loadAllJobs();
    logPrinterActivity('Dashboard manually refreshed', 'blue');
  });

  document.getElementById('open-shop-btn').addEventListener('click', () => {
    if (config && config.shopSlug) {
      window.electronAPI.openExternal(`${config.serverUrl}/shop/${config.shopSlug}`);
    } else {
      showToast('Store URL not configured yet.', 'error');
    }
  });

  document.getElementById('flush-spooler-btn').addEventListener('click', flushPrintSpooler);

  document.getElementById('toggle-mode-btn').addEventListener('click', async () => {
    config.autoPrint = !config.autoPrint;
    await window.electronAPI.saveConfig(config);
    updateModeUI();
    showToast(config.autoPrint ? '[AUTO] Auto-Print ON' : '[SEMI] Semi-Auto ON');
    logPrinterActivity(`Print mode changed to ${config.autoPrint ? 'AUTO' : 'SEMI-AUTO'}`, 'orange');
  });

  document.getElementById('copy-qr-link-btn').addEventListener('click', () => {
    const val = document.getElementById('qr-link-input').value;
    navigator.clipboard.writeText(val).catch(() => {});
    const btn = document.getElementById('copy-qr-link-btn');
    btn.innerText = 'Copied!';
    setTimeout(() => { btn.innerText = 'Copy'; }, 1800);
  });

  document.getElementById('reload-qr-btn').addEventListener('click', loadQR);
  document.getElementById('print-poster-btn').addEventListener('click', printCounterPoster);
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('reset-setup-btn').addEventListener('click', () => showSetupModal(true));
  document.getElementById('jobs-status-filter').addEventListener('change', loadAllJobs);

  // Search input on dashboard
  const dashSearch = document.getElementById('dash-search-input');
  if (dashSearch) {
    dashSearch.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.trim().toLowerCase();
      applyDashboardFilter();
    });
  }

  // Filter dropdown on dashboard
  const filterSelect = document.getElementById('dash-job-filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      setDashboardFilter(e.target.value);
    });
  }

  // Filter tabs on dashboard
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      const filter = pill.getAttribute('data-filter');
      setDashboardFilter(filter);
    });
  });

  // CTA Scan QR button
  const ctaBtn = document.getElementById('cta-scan-qr-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('click', () => {
      const qrNav = document.querySelector('.nav-item[data-page="qr"]');
      if (qrNav) qrNav.click();
    });
  }

  // Select all checkbox
  const checkAll = document.getElementById('dash-check-all');
  if (checkAll) {
    checkAll.addEventListener('change', (e) => {
      const checks = document.querySelectorAll('.row-job-check');
      checks.forEach(c => c.checked = e.target.checked);
    });
  }

  // View all activity link
  const viewAllAct = document.getElementById('view-all-activity-link');
  if (viewAllAct) {
    viewAllAct.addEventListener('click', (e) => {
      e.preventDefault();
      const jobsNav = document.querySelector('.nav-item[data-page="jobs"]');
      if (jobsNav) jobsNav.click();
    });
  }

  // Auth Gate Screen Tabs
  const authTabLogin = document.getElementById('auth-tab-login');
  const authTabReg = document.getElementById('auth-tab-register');
  if (authTabLogin && authTabReg) {
    authTabLogin.addEventListener('click', () => {
      authTabLogin.classList.add('active');
      authTabReg.classList.remove('active');
      document.getElementById('auth-login-pane').style.display = 'block';
      document.getElementById('auth-register-pane').style.display = 'none';
    });
    authTabReg.addEventListener('click', () => {
      authTabReg.classList.add('active');
      authTabLogin.classList.remove('active');
      document.getElementById('auth-register-pane').style.display = 'block';
      document.getElementById('auth-login-pane').style.display = 'none';
    });
  }

  document.getElementById('submit-register-btn').addEventListener('click', handleRegister);
  document.getElementById('submit-login-btn').addEventListener('click', handleEmailLogin);
  const submitTokenBtn = document.getElementById('submit-token-login-btn');
  if (submitTokenBtn) submitTokenBtn.addEventListener('click', handleTokenLogin);

  const googleLoginBtn = document.getElementById('google-login-btn');
  if (googleLoginBtn) googleLoginBtn.addEventListener('click', handleGoogleDesktopLogin);
  const googleRegBtn = document.getElementById('google-reg-btn');
  if (googleRegBtn) googleRegBtn.addEventListener('click', handleGoogleDesktopLogin);
  const googleCancelBtn = document.getElementById('google-login-cancel-btn');
  if (googleCancelBtn) googleCancelBtn.addEventListener('click', cancelGoogleDesktopLogin);

  const logoutBtn = document.getElementById('nav-logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  // Reject modal confirm
  document.getElementById('confirm-reject-btn').addEventListener('click', confirmReject);

  // Pay at counter toggle handler
  const pacToggle = document.getElementById('settings-pay-at-counter');
  if (pacToggle) {
    pacToggle.addEventListener('change', (e) => {
      const row = document.getElementById('pac-autoprint-row');
      if (row) row.style.display = e.target.checked ? 'flex' : 'none';
    });
  }
}

//  Config UI 
function applyConfigUI() {
  document.getElementById('sidebar-shop-name').innerText    = config.shopName || 'QrPrintDesk';
  document.getElementById('sidebar-station-name').innerText = config.shopSlug ? `@${config.shopSlug}` : 'Vendor Station';
  updateModeUI();
  document.getElementById('settings-server-url').value     = config.serverUrl || 'https://print.qrprintdesk.in';
  document.getElementById('settings-auto-enhance').checked = config.autoEnhance !== false;
  document.getElementById('settings-sound-alert').checked  = config.soundAlert  !== false;

  const pacInput = document.getElementById('settings-pay-at-counter');
  const pacAutoPrintInput = document.getElementById('settings-pac-autoprint');
  const pacRow = document.getElementById('pac-autoprint-row');
  if (pacInput) {
    pacInput.checked = config.payAtCounter === true;
    if (pacRow) pacRow.style.display = config.payAtCounter ? 'flex' : 'none';
  }
  if (pacAutoPrintInput) {
    pacAutoPrintInput.checked = config.pacAutoPrint === true;
  }
}

function updateModeUI() {
  const badge = document.getElementById('mode-badge');
  const text  = document.getElementById('mode-btn-text');
  if (config.autoPrint) {
    badge.innerText = 'AUTO';
    badge.style.background = '#dcfce7';
    badge.style.color = '#15803d';
    text.innerText = 'Auto-Print';
  } else {
    badge.innerText = 'SEMI';
    badge.style.background = '#fef3c7';
    badge.style.color = '#b45309';
    text.innerText = 'Semi-Auto';
  }
}

//  WebSocket 
function initWebSocket() {
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }

  updateConnectionStatus('connecting');

  const wsUrl = config.serverUrl.replace(/^http/, 'ws')
    + `/ws/agent?token=${encodeURIComponent(config.agentToken)}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      updateConnectionStatus('online');
      logPrinterActivity('[ONLINE] Connected to QrPrintDesk Cloud Engine', 'green');
      refreshDashboard();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'job' && msg.id) {
          const shortId = msg.id.substring(0, 8);
          logPrinterActivity(`Incoming job #${shortId} received`, 'blue');
          if (config.soundAlert) playChime();
          showProminentJobNotifier(msg.id);
          const isPayAtCounterJob = msg.payAtCounter === true;
          const shouldAutoPrint = config.autoPrint && (!isPayAtCounterJob || config.pacAutoPrint === true);
          if (shouldAutoPrint) {
            handleAutoPrint(msg.id); // non-blocking: queued in FIFO
          } else if (isPayAtCounterJob && !config.pacAutoPrint) {
            logPrinterActivity(`Pay-at-counter order #${shortId} held for manual print (cash verification)`, 'orange');
          }
          invalidateCache('jobs', 'dashboard');
          refreshDashboard(true);
          const jobPage = document.getElementById('page-jobs');
          if (jobPage && jobPage.classList.contains('active')) loadAllJobs();
        }
      } catch (err) { console.error('WS message error:', err); }
    };

    ws.onclose = () => {
      updateConnectionStatus('disconnected');
      logPrinterActivity('[RETRY] WebSocket disconnected - retrying...', 'orange');
      scheduleReconnect();
    };

    ws.onerror = () => {
      updateConnectionStatus('disconnected');
    };
  } catch (err) { scheduleReconnect(); }
}

function updateConnectionStatus(status) {
  const pill = document.getElementById('sidebar-connection-pill');
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  pill.className = `connection-pill ${status}`;
  dot.className  = `status-dot ${status}`;

  if (status === 'online') {
    text.innerText = 'Connected';
  } else if (status === 'connecting') {
    text.innerText = 'Connecting...';
  } else {
    text.innerText = 'Offline';
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(initWebSocket, 4000);
}

function startDashboardPolling() {
  if (dashboardPollTimer) clearInterval(dashboardPollTimer);
  dashboardPollTimer = setInterval(() => {
    const dash = document.getElementById('page-dashboard');
    if (dash && dash.classList.contains('active')) refreshDashboard();
  }, 25000);
}

//  Prominent Job Notifier & Chime 
let jobToastTimer = null;
let jobCountdownInterval = null;

function showProminentJobNotifier(jobId) {
  const toast = document.getElementById('new-job-toast');
  const sub = document.getElementById('new-job-toast-sub');
  const countdownBar = document.getElementById('toast-auto-countdown-bar');
  const countdownSec = document.getElementById('toast-countdown-seconds');
  const countdownProgress = document.getElementById('toast-countdown-progress');

  if (!toast) return;

  const shortId = (jobId || '').substring(0, 8);
  sub.innerText = `Job #${shortId} ready for counter pickup`;
  toast.style.display = 'block';

  if (jobToastTimer) clearTimeout(jobToastTimer);
  if (jobCountdownInterval) clearInterval(jobCountdownInterval);

  if (config.autoPrint) {
    countdownBar.style.display = 'block';
    countdownSec.innerText = 'Sending to printer...';
    countdownProgress.style.width = '100%';
    countdownProgress.style.background = '#22c55e';
    // Auto dismiss after 4 seconds once printed
    jobToastTimer = setTimeout(() => { dismissNewJobToast(); }, 4000);
  } else {
    countdownBar.style.display = 'none';
    jobToastTimer = setTimeout(() => { dismissNewJobToast(); }, 8000);
  }
}

window.dismissNewJobToast = function() {
  const toast = document.getElementById('new-job-toast');
  if (toast) toast.style.display = 'none';
  if (jobToastTimer) clearTimeout(jobToastTimer);
  if (jobCountdownInterval) clearInterval(jobCountdownInterval);
};

function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [{ f: 587, t: 'sine', d: 0 }, { f: 880, t: 'sine', d: .15 }, { f: 440, t: 'triangle', d: 0 }].forEach(({ f, t, d }) => {
      const osc = audioCtx.createOscillator();
      const g   = audioCtx.createGain();
      osc.type = t; osc.frequency.value = f;
      g.gain.setValueAtTime(.14, now + d);
      g.gain.exponentialRampToValueAtTime(.001, now + d + .7);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start(now + d); osc.stop(now + d + .75);
    });
  } catch (e) {}
}

//  Activity Log Helper 
function logPrinterActivity(msg, type = 'blue') {
  const list = document.getElementById('printer-activity-list');
  if (!list) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const item = document.createElement('div');
  item.className = 'activity-row';
  item.innerHTML = `
    <div class="activity-dot ${type}"></div>
    <span class="activity-time">${timeStr}</span>
    <span class="activity-msg">${escHtml(msg)}</span>
  `;

  list.insertBefore(item, list.firstChild);
  while (list.children.length > 8) {
    list.removeChild(list.lastChild);
  }
}

//  Toast 
function showToast(message, type = 'info') {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  const bg = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#0f172a';
  t.style.cssText = `background:${bg};color:#ffffff;padding:10px 16px;border-radius:10px;font-size:12.5px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.15);max-width:320px;animation:slideIn .25s ease;`;
  t.innerText = message;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3500);
}

//  Flush Print Spooler 
async function flushPrintSpooler() {
  const btn = document.getElementById('flush-spooler-btn');
  if (!confirm('This will purge all queued Windows print spooler documents.\n\nContinue?')) return;

  btn.disabled = true;
  btn.innerText = 'Purging...';

  try {
    const result = await window.electronAPI.flushSpooler();
    if (result.success) {
      showToast(result.message || 'Windows print spooler cleared!', 'success');
      logPrinterActivity(result.message || 'Windows print spooler flushed', 'orange');
      // Immediately refresh printer status and queue count
      await refreshPrinterList();
    } else {
      showToast(`[WARN] Spooler flush: ${result.message || 'Partial'}`, 'error');
    }
  } catch (err) {
    showToast(`[ERROR] Spooler flush error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.37"/></svg> Flush Spooler`;
  }
}

//  Hardware Print Spooler Page Audit 
window.runSpoolerAudit = async function() {
  const btn = document.getElementById('spooler-audit-btn');
  if (btn) btn.disabled = true;
  showToast('Auditing hardware print spooler...', 'info');
  try {
    const res = await window.electronAPI.getSpoolerAudit();
    const jobs = res && res.jobs ? res.jobs : [];
    const totalQueuedPages = jobs.reduce((sum, j) => sum + (Number(j.TotalPages) || 0), 0);
    const totalPrinted = jobs.reduce((sum, j) => sum + (Number(j.PagesPrinted) || 0), 0);
    const activePrinters = jobs.map(j => j.DriverName).filter(Boolean);
    const uniqueDrivers = Array.from(new Set(activePrinters)).join(', ') || config.printerName || 'Default Printer';

    alert(`Hardware Print Spooler Audit:\n\nActive Printer: ${uniqueDrivers}\nTotal Spooler Jobs: ${jobs.length}\nTotal Pages Spooled: ${totalQueuedPages}\nPages Completed: ${totalPrinted}\n\nTip: Match this against your daily counter log to verify 100% paper accountability.`);
    logPrinterActivity(`Hardware spooler audit run: ${jobs.length} jobs, ${totalQueuedPages} pages`, 'blue');
  } catch (err) {
    showToast(`Audit error: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

//  Hardware Diagnostic Test 
async function testPrinterCommunication() {
  showToast('Testing printer connection...', 'info');
  try {
    const printers = await window.electronAPI.getPrinters();
    const active = printers.find(p => p.name === config.printerName || (!config.printerName && p.isDefault));
    if (active) {
      showToast(`[OK] Printer responded: ${active.name} [${active.status || 'Ready'}]`, 'success');
      logPrinterActivity(`Printer health test passed: ${active.name}`, 'green');
    } else {
      showToast('No active printer responded to test query', 'error');
    }
  } catch (e) {
    showToast(`Test failed: ${e.message}`, 'error');
  }
}

//  Auto-Print — now routes through FIFO queue for safe serial execution
function handleAutoPrint(jobId) {
  logPrinterActivity(`[QUEUE] Job #${jobId.substring(0, 8)} added to print queue (pos ${_printQueue.length + (_isPrinting ? 1 : 0) + 1})`, 'blue');
  enqueuePrintJob(jobId);
}

//  Dashboard 
async function refreshDashboard(force = false) {
  if (!config || !config.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };

  //  Stale-while-revalidate: render cached data instantly 
  const cachedDash = _apiCache.get('dashboard');
  if (cachedDash && !force) _applyDashboardData(cachedDash.data);
  const cachedJobs = _apiCache.get('jobs');
  if (cachedJobs && !force) {
    allFetchedJobs = cachedJobs.data.jobs || [];
    updatePillCounts();
    applyDashboardFilter();
  }

  //  Fetch fresh data in background (or immediately if forced) 
  try {
    const [dashData, jobsData] = await Promise.all([
      apiFetch('dashboard', `${config.serverUrl}/api/vendor/dashboard`,    { headers: hdr }, CACHE_TTL.dashboard, force),
      apiFetch('jobs',      `${config.serverUrl}/api/vendor/jobs?limit=50`, { headers: hdr }, CACHE_TTL.jobs,      force)
    ]);
    _applyDashboardData(dashData);
    allFetchedJobs = jobsData.jobs || [];
    updatePillCounts();
    applyDashboardFilter();
    loadSubscriptionFromServer(force);
  } catch (err) {
    console.error('Dashboard refresh failed:', err);
  }
}

/** Apply dashboard API response to the DOM */
function _applyDashboardData(data) {
  if (!data || !data.stats) return;
  const s = data.stats;
  document.getElementById('stat-today-orders').innerText   = s.todayOrders         ?? 0;
  document.getElementById('stat-pending-jobs').innerText   = s.pendingJobs         ?? 0;
  document.getElementById('stat-completed-jobs').innerText = s.completedTodayJobs  ?? 0;
  document.getElementById('stat-today-revenue').innerText  = `${s.revenueTodayRupees ?? '0.00'}`;
  if (data.shop && data.shop.name) {
    config.shopName = data.shop.name;
    document.getElementById('sidebar-shop-name').innerText = data.shop.name;
  }
}

function updatePillCounts() {
  const allCount       = allFetchedJobs.length;
  const activeCount    = allFetchedJobs.filter(j => ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'PRINTING'].includes((j.status || '').toUpperCase())).length;
  const completedCount = allFetchedJobs.filter(j => (j.status || '').toUpperCase() === 'COMPLETED').length;
  const failedCount    = allFetchedJobs.filter(j => ['FAILED', 'REJECTED'].includes((j.status || '').toUpperCase())).length;
  const cancelledCount = allFetchedJobs.filter(j => (j.status || '').toUpperCase() === 'CANCELLED').length;

  document.getElementById('pill-count-all').innerText       = allCount;
  document.getElementById('pill-count-active').innerText    = activeCount;
  document.getElementById('pill-count-completed').innerText = completedCount;
  document.getElementById('pill-count-failed').innerText    = failedCount;
  document.getElementById('pill-count-cancelled').innerText = cancelledCount;
}

function setDashboardFilter(filter) {
  currentFilter = filter;

  // Update pills active class
  document.querySelectorAll('.filter-pill').forEach(pill => {
    if (pill.getAttribute('data-filter') === filter) pill.classList.add('active');
    else pill.classList.remove('active');
  });

  // Sync dropdown
  const filterSelect = document.getElementById('dash-job-filter-select');
  if (filterSelect && filterSelect.value !== filter) filterSelect.value = filter;

  applyDashboardFilter();
}

function applyDashboardFilter() {
  let filtered = allFetchedJobs;

  if (currentFilter === 'active') {
    filtered = filtered.filter(j => ['QUEUED', 'DOWNLOADING', 'PRINT_SUBMITTED', 'PRINTING'].includes((j.status || '').toUpperCase()));
  } else if (currentFilter === 'completed') {
    filtered = filtered.filter(j => (j.status || '').toUpperCase() === 'COMPLETED');
  } else if (currentFilter === 'failed') {
    filtered = filtered.filter(j => ['FAILED', 'REJECTED'].includes((j.status || '').toUpperCase()));
  } else if (currentFilter === 'cancelled') {
    filtered = filtered.filter(j => (j.status || '').toUpperCase() === 'CANCELLED');
  }

  if (currentSearchQuery) {
    filtered = filtered.filter(j => {
      const o = j.order || {};
      const cName = (o.customerName || '').toLowerCase();
      const cPhone = (o.customerPhone || '').toLowerCase();
      const fNames = (o.files || []).map(f => (f.originalFilename || '').toLowerCase()).join(' ');
      const jid = (j.jobId || '').toLowerCase();
      return cName.includes(currentSearchQuery) || cPhone.includes(currentSearchQuery) || fNames.includes(currentSearchQuery) || jid.includes(currentSearchQuery);
    });
  }

  renderDashboardTable(filtered);
}

function renderDashboardTable(jobs) {
  const tbody = document.getElementById('dashboard-jobs-tbody');
  const emptyState = document.getElementById('dash-empty-state');
  const table = document.getElementById('dash-table');

  if (!jobs || jobs.length === 0) {
    tbody.innerHTML = '';
    table.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  table.style.display = 'table';
  emptyState.style.display = 'none';

  tbody.innerHTML = jobs.map((j) => {
    const o   = j.order || {};
    const pickupCode = o.pickupCode || j.pickupCode || (j.orderId ? '#' + j.orderId.slice(-4).toUpperCase() : (j.jobId ? '#' + j.jobId.slice(-4).toUpperCase() : '-'));
    const customerDisplay = buildCustomerDisplay(o);
    const documentName    = buildDocumentDisplay(o);
    const pageCount       = (o.files || []).reduce((acc, f) => acc + (f.pageCount || 1), 0);
    const optsDisplay     = buildOptsDisplay(o);
    const amt  = o.amountRupees ? `${o.amountRupees}` : '-';
    const time = j.createdAt ? new Date(j.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
    const st   = (j.status || '').toLowerCase();
    const canAct = !['completed', 'rejected', 'cancelled'].includes(st);

    return `<tr>
      <td style="width:85px;"><span class="pickup-badge">${escHtml(pickupCode)}</span></td>
      <td style="width:140px;">${customerDisplay}</td>
      <td style="min-width:160px;max-width:260px;">${documentName}</td>
      <td style="width:55px;text-align:center;font-weight:700;">${pageCount}</td>
      <td style="width:130px;">${optsDisplay}</td>
      <td style="width:75px;text-align:right;"><strong>${amt}</strong></td>
      <td style="width:95px;text-align:center;">${statusBadgeHtml(j.status)}</td>
      <td style="width:75px;text-align:center;font-size:11px;color:var(--text-dim);">${time}</td>
      <td style="text-align:right;white-space:nowrap;min-width:165px;">
        <button class="btn btn-secondary btn-xs" onclick="openJobModal('${j.jobId}')">View</button>
        ${st === 'completed' 
          ? `<button class="btn btn-success btn-xs" style="background:#16a34a;color:#ffffff;border:none;margin-left:2px;" onclick="sendWhatsAppReady('${j.jobId}', '${escHtml(o.customerPhone || '')}', '${escHtml(pickupCode)}', '${amt}')">WhatsApp</button>` 
          : `<button class="btn btn-primary btn-xs" onclick="printJobRow('${j.jobId}')">Print</button>
             <button class="btn btn-success btn-xs" style="background:#10b981;color:#ffffff;border:none;margin-left:2px;" onclick="completeJobRow('${j.jobId}')" title="Mark completed / Ready for pickup">Done</button>`
        }
        ${canAct ? `<button class="btn btn-danger btn-xs" onclick="openRejectModal('${j.jobId}')">Reject</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

//  Build Display Helpers 
function buildCustomerDisplay(o) {
  if (!o) return '<span style="color:var(--text-dim)">-</span>';
  const name  = o.customerName  ? `<div style="font-weight:700;color:#0f172a;">${escHtml(o.customerName)}</div>` : '<div style="font-weight:600;color:#64748b;">Walk-in</div>';
  const phone = o.customerPhone ? `<div style="font-size:11px;color:var(--text-dim);">${escHtml(o.customerPhone)}</div>` : '';
  return name + phone;
}

function buildDocumentDisplay(o) {
  if (!o || !o.files || o.files.length === 0) return '<span style="color:var(--text-dim)">-</span>';
  const first = o.files[0];
  const name = escHtml(first.originalFilename || 'Document');
  const extra = o.files.length > 1 ? ` <span style="font-size:10.5px;color:#2563eb;font-weight:600;">+${o.files.length - 1} more</span>` : '';
  return `<div style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}${extra}</div>`;
}

function buildOptsDisplay(o) {
  if (!o) return '-';
  const tags = [];
  if (o.colorMode)      tags.push(o.colorMode === 'color' ? ' Color' : ' B&W');
  if (o.copies > 1)     tags.push(`${o.copies}`);
  if (o.duplexMode && o.duplexMode !== 'simplex') tags.push('2-sided');
  if (o.pagesPerSheet === 2) tags.push('2-on-1');
  if (o.orientation)    tags.push(o.orientation);
  if (o.pageRange)      tags.push(` p.${o.pageRange}`);
  return `<div class="opts-pill">${tags.map(t => `<span class="opt-tag">${t}</span>`).join('')}</div>`;
}

//  Job Detail Modal 
window.openJobModal = async function(jobId) {
  currentJobModalId = jobId;
  document.getElementById('job-modal').classList.add('active');
  document.getElementById('job-modal-content').innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-dim);">Loading job specifications...</div>';
  document.getElementById('job-modal-actions').innerHTML = '';

  try {
    const hdr = { 'Authorization': `Bearer ${config.agentToken}` };

    //  Find job from cache (avoid re-fetching all 50 jobs) 
    let job = null;
    const cachedJobs = _apiCache.get('jobs');
    if (cachedJobs) job = (cachedJobs.data.jobs || []).find(j => j.jobId === jobId);

    // Fetch jobs only if not in cache
    if (!job) {
      const data = await apiFetch('jobs', `${config.serverUrl}/api/vendor/jobs?limit=50`, { headers: hdr }, CACHE_TTL.jobs);
      job = (data.jobs || []).find(j => j.jobId === jobId);
    }
    if (!job) throw new Error('Job not found');

    //  Get presigned download URLs (cached by jobId, 55 s TTL) 
    let downloadUrls = [];
    try {
      const dlMeta = await apiFetch(`dlurl:${jobId}`, `${config.serverUrl}/api/agent/jobs/${jobId}/download-url`, { headers: hdr }, CACHE_TTL.dlurl);
      downloadUrls = dlMeta.files || [];
    } catch (_) {}

    const o   = job.order || {};
    const pickupCode = o.pickupCode || job.pickupCode || (job.orderId ? '#' + job.orderId.slice(-4).toUpperCase() : (job.jobId ? '#' + job.jobId.slice(-4).toUpperCase() : '-'));
    const st  = (job.status || '').toLowerCase();
    const canAct = !['completed', 'rejected', 'cancelled'].includes(st);

    window.jobOverrides = window.jobOverrides || {};
    const activeColor  = (window.jobOverrides[jobId]?.colorMode) || o.colorMode || 'monochrome';
    const activeCopies = (window.jobOverrides[jobId]?.copies) !== undefined ? window.jobOverrides[jobId].copies : (o.copies || 1);
    const activeStamp  = (window.jobOverrides[jobId]?.stampPaperMode) !== undefined ? window.jobOverrides[jobId].stampPaperMode : Boolean(o.stampPaperMode);

    const content = `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#1e40af;letter-spacing:0.5px;">Customer Pickup Code</div>
          <div style="font-size:12px;color:#3b82f6;margin-top:2px;">Customer presents this code at the counter to collect prints</div>
        </div>
        <div class="pickup-badge" style="font-size:18px;padding:6px 14px;border-radius:8px;background:#ffffff;box-shadow:0 1px 3px rgba(37,99,235,0.15);">${escHtml(pickupCode)}</div>
      </div>

      <div class="job-detail-grid">
        <div class="job-detail-item">
          <div class="job-detail-label">Customer</div>
          <div class="job-detail-value">${escHtml(o.customerName || 'Walk-in Customer')}</div>
          ${o.customerPhone ? `<div class="job-detail-sub">${escHtml(o.customerPhone)}</div>` : ''}
        </div>
        <div class="job-detail-item">
          <div class="job-detail-label">Job ID</div>
          <div class="job-detail-value" style="font-family:monospace;font-size:12.5px;">${job.jobId}</div>
          <div class="job-detail-sub">Order: ${job.orderId}</div>
        </div>
        <div class="job-detail-item">
          <div class="job-detail-label">Total Amount</div>
          <div class="job-detail-value">${o.amountRupees || '0.00'}</div>
        </div>
        <div class="job-detail-item">
          <div class="job-detail-label">Status</div>
          <div class="job-detail-value">${statusBadgeHtml(job.status)}</div>
          ${job.failureReason ? `<div class="job-detail-sub" style="color:#ef4444;">${escHtml(job.failureReason)}</div>` : ''}
        </div>
      </div>

      <!-- Quick Counter Override Toolbar to fix customer mistakes without re-upload -->
      <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:12px 14px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font-size:12px;font-weight:800;color:#166534;display:flex;align-items:center;gap:5px;">
            <span style="display:inline-flex;align-items:center;gap:5px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Counter Quick-Adjust (Fix Customer Mistake)
            </span>
          </div>
          <span style="font-size:11px;color:#15803d;font-weight:600;">Overrides apply instantly when you click Print</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:10px;">
          <div style="background:#ffffff;padding:8px 10px;border-radius:8px;border:1px solid #bbf7d0;">
            <div style="font-size:11px;font-weight:700;color:#166534;margin-bottom:4px;">Copies</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="btn btn-secondary btn-xs" onclick="adjustJobCopies('${jobId}', -1)">-</button>
              <span id="override-copies-${jobId}" style="font-weight:800;font-size:14px;min-width:20px;text-align:center;">${activeCopies}</span>
              <button type="button" class="btn btn-secondary btn-xs" onclick="adjustJobCopies('${jobId}', 1)">+</button>
            </div>
          </div>
          <div style="background:#ffffff;padding:8px 10px;border-radius:8px;border:1px solid #bbf7d0;">
            <div style="font-size:11px;font-weight:700;color:#166534;margin-bottom:4px;">Color Mode</div>
            <button type="button" id="override-color-${jobId}" class="btn btn-xs ${activeColor === 'color' ? 'btn-primary' : 'btn-secondary'}" onclick="toggleJobColor('${jobId}')" style="width:100%;">
              ${activeColor === 'color' ? 'Color' : 'Black & White'}
            </button>
          </div>
          <div style="background:#ffffff;padding:8px 10px;border-radius:8px;border:1px solid #bbf7d0;">
            <div style="font-size:11px;font-weight:700;color:#166534;margin-bottom:4px;">Stamp Paper</div>
            <button type="button" id="override-stamp-${jobId}" class="btn btn-xs ${activeStamp ? 'btn-primary' : 'btn-secondary'}" onclick="toggleJobStamp('${jobId}')" style="width:100%;">
              ${activeStamp ? 'Stamp (3.5")' : 'Standard'}
            </button>
          </div>
        </div>
      </div>

      <div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div class="job-detail-label" style="margin-bottom:10px;">Original Customer Print Options</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${printOptTag('Color', o.colorMode === 'color' ? ' Color' : ' B&W')}
          ${printOptTag('Copies', `${o.copies || 1}`)}
          ${printOptTag('Sides', sideName(o.duplexMode))}
          ${printOptTag('Layout', o.pagesPerSheet === 2 ? '2-on-1' : '1 per sheet')}
          ${printOptTag('Orientation', o.orientation || 'portrait')}
          ${printOptTag('Paper', o.paperSize || 'A4')}
          ${o.stampPaperMode ? printOptTag('Stamp Paper', 'Yes (3.5" Margin)') : ''}
        </div>
      </div>

      <div class="job-detail-label" style="margin-bottom:8px;">Attached Documents & Photos (${(o.files || []).length})</div>
      <div class="files-list">
        ${(o.files || []).map((f, idx) => {
          const dl = downloadUrls[idx] || downloadUrls.find(d => d.originalFilename === f.originalFilename) || {};
          const fileUrl = dl.downloadUrl || '';
          const isImg = f.mimeType?.includes('image') || /\.(jpe?g|png|webp|bmp)$/i.test(f.originalFilename || '');
          const pageBadge = f.pageRange 
            ? `<span style="background:#fee2e2;color:#b91c1c;font-weight:700;padding:1px 6px;border-radius:4px;font-size:11px;">Pgs: ${escHtml(f.pageRange)}</span>` 
            : `<span style="color:var(--text-muted);">${f.pageCount || 1} pgs</span>`;
          const copyBadge = (f.copies && f.copies > 1) 
            ? `<span style="background:#fef3c7;color:#92400e;font-weight:700;padding:1px 6px;border-radius:4px;font-size:11px;">${f.copies} copies</span>` 
            : '';
          const colorBadge = f.colorMode 
            ? `<span style="background:${f.colorMode === 'color' ? '#dbeafe' : '#f1f5f9'};color:${f.colorMode === 'color' ? '#1e40af' : '#475569'};font-weight:700;padding:1px 6px;border-radius:4px;font-size:11px;">${f.colorMode === 'color' ? 'Color' : 'B&W'}</span>` 
            : '';
          const docIcon = isImg
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
          return `
          <div class="file-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#ffffff;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,0.03);">
            <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1;">
              <div style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:var(--surface-subtle);border-radius:6px;">${docIcon}</div>
              <div style="min-width:0;flex:1;">
                <div class="file-name" style="font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(f.originalFilename)}</div>
                <div class="file-meta" style="font-size:11.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;">
                  ${pageBadge} ${copyBadge} ${colorBadge}
                  <span style="color:var(--text-muted);">· ${formatSize(f.fileSize)}</span>
                </div>
              </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-left:12px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="previewSpecificFile('${encodeURIComponent(fileUrl)}', '${escHtml(f.originalFilename)}', '${jobId}', ${idx})">
                 View Document
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;

    document.getElementById('job-modal-content').innerHTML = content;

    const actionsHtml = canAct ? `
      <button class="btn btn-primary" onclick="printJobRow('${jobId}');closeJobModal();">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Print Now
      </button>
      <button class="btn btn-success" style="background:#10b981;color:#ffffff;border:none;" onclick="completeJobRow('${jobId}');closeJobModal();" title="Mark print completed and ready">
        Mark Done
      </button>
      <button class="btn btn-secondary" onclick="previewJobRow('${jobId}')">
        Preview Full Document
      </button>
      <button class="btn btn-success" style="background:#16a34a;color:#ffffff;border:none;" onclick="sendWhatsAppReady('${jobId}', '${escHtml(o.customerPhone || '')}', '${escHtml(pickupCode)}', '${o.amountRupees || '0.00'}')">
        WhatsApp Ready
      </button>
      <button class="btn btn-danger" onclick="closeJobModal();openRejectModal('${jobId}')">
        Reject Job
      </button>
    ` : `
      <button class="btn btn-success" style="background:#16a34a;color:#ffffff;border:none;" onclick="sendWhatsAppReady('${jobId}', '${escHtml(o.customerPhone || '')}', '${escHtml(pickupCode)}', '${o.amountRupees || '0.00'}')">
        WhatsApp Ready
      </button>
      <button class="btn btn-secondary" onclick="printJobRow('${jobId}');closeJobModal();">
        Reprint
      </button>
      <span style="color:var(--text-dim);font-size:12.5px;margin-left:8px;">Job is ${job.status}</span>
    `;

    document.getElementById('job-modal-actions').innerHTML = actionsHtml;
  } catch (err) {
    document.getElementById('job-modal-content').innerHTML = `<div style="color:var(--red);padding:20px;">${err.message}</div>`;
  }
};

window.previewSpecificFile = async function(encodedUrl, filename, jobId, index) {
  const fileUrl = decodeURIComponent(encodedUrl || '');
  if (!fileUrl) {
    showToast('Document download URL not available.', 'error');
    return;
  }
  showToast('Opening document...', 'info');
  try {
    const res = await window.electronAPI.previewJob({ fileUrl, filename, jobId, index: index ?? 0 });
    if (res && !res.success) {
      showToast(`Preview failed: ${res.error || 'Could not open file'}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.closeJobModal = function() {
  document.getElementById('job-modal').classList.remove('active');
  currentJobModalId = null;
};

function printOptTag(label, value) {
  return `<div style="background:#ffffff;border:1px solid var(--border);border-radius:6px;padding:6px 10px;">
    <div style="font-size:10px;color:var(--text-dim);margin-bottom:2px;">${label}</div>
    <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${value}</div>
  </div>`;
}

function sideName(mode) {
  if (mode === 'duplexlong')  return '2-Sided (Long)';
  if (mode === 'duplexshort') return '2-Sided (Short)';
  return 'Single-Sided';
}

function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

//  Reject Modal 
window.openRejectModal = function(jobId) {
  currentRejectJobId = jobId;
  document.getElementById('reject-reason-input').value = '';
  document.getElementById('reject-modal').classList.add('active');
};

window.closeRejectModal = function() {
  document.getElementById('reject-modal').classList.remove('active');
  currentRejectJobId = null;
};

async function confirmReject() {
  if (!currentRejectJobId) return;
  const reason = document.getElementById('reject-reason-input').value.trim() || 'Rejected by vendor';
  const btn = document.getElementById('confirm-reject-btn');
  btn.disabled = true;
  btn.innerText = 'Rejecting...';

  try {
    const res = await fetch(`${config.serverUrl}/api/vendor/jobs/${currentRejectJobId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.agentToken}` },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');

    closeRejectModal();
    showToast(`[REJECTED] Job #${currentRejectJobId.substring(0, 8)} rejected.`, 'error');
    logPrinterActivity(`Job #${currentRejectJobId.substring(0, 8)} rejected`, 'orange');
    invalidateCache('jobs', 'dashboard');
    refreshDashboard(true);
    const jobPage = document.getElementById('page-jobs');
    if (jobPage && jobPage.classList.contains('active')) loadAllJobs();
  } catch (err) {
    alert(`Reject failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Confirm Reject';
  }
}

//  All Jobs Page 
async function loadAllJobs() {
  if (!config || !config.agentToken) return;
  const statusFilter = document.getElementById('jobs-status-filter').value;
  const cacheKey = `jobs${statusFilter ? '_' + statusFilter : ''}`;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
  let url = `${config.serverUrl}/api/vendor/jobs?limit=50`;
  if (statusFilter) url += `&status=${statusFilter}`;

  const tbody = document.getElementById('all-jobs-tbody');

  //  Show cached data instantly, then refresh in background 
  const cached = _apiCache.get(cacheKey) || (statusFilter ? null : _apiCache.get('jobs'));
  if (cached) {
    _renderJobsTable(tbody, cached.data.jobs || []);
  } else {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:28px;color:var(--text-dim);">Loading...</td></tr>`;
  }

  try {
    const data = await apiFetch(cacheKey, url, { headers: hdr }, CACHE_TTL.jobs);
    // Also update the shared 'jobs' key if no filter is active so openJobModal can use it
    if (!statusFilter) _apiCache.set('jobs', { data, ts: Date.now() });
    allFetchedJobs = data.jobs || [];
    updatePillCounts();
    _renderJobsTable(tbody, allFetchedJobs);
  } catch (err) {
    if (!cached) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red);padding:28px;">Failed: ${err.message}</td></tr>`;
  }
}

function _renderJobsTable(tbody, jobs) {
  if (!jobs || jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:40px;">
      <div style="font-size:24px;margin-bottom:8px;"></div>No print jobs found</td></tr>`;
    return;
  }
  tbody.innerHTML = jobs.map(j => {
    const o   = j.order || {};
    const pickupCode = o.pickupCode || j.pickupCode || (j.orderId ? '#' + j.orderId.slice(-4).toUpperCase() : (j.jobId ? '#' + j.jobId.slice(-4).toUpperCase() : '-'));
    const jid = j.jobId ? j.jobId.substring(0, 8) : '-';
    const customerDisplay = buildCustomerDisplay(o);
    const documentName    = buildDocumentDisplay(o);
    const optsDisplay     = buildOptsDisplay(o);
    const amt  = o.amountRupees ? `${o.amountRupees}` : '-';
    const time = j.createdAt ? new Date(j.createdAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '-';
    const st   = (j.status || '').toLowerCase();
    const canAct = !['completed', 'rejected', 'cancelled'].includes(st);

    return `<tr>
      <td style="width:75px;"><span class="pickup-badge">${escHtml(pickupCode)}</span></td>
      <td>${customerDisplay}</td>
      <td><code style="font-size:11px;">${jid}</code></td>
      <td>${documentName}</td>
      <td>${optsDisplay}</td>
      <td>${amt}</td>
      <td>${statusBadgeHtml(j.status)}</td>
      <td style="font-size:11.5px;color:var(--text-dim);">${time}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary btn-xs" onclick="openJobModal('${j.jobId}')">View</button>
        <button class="btn btn-secondary btn-xs" onclick="printJobRow('${j.jobId}')">Reprint</button>
        ${canAct ? `<button class="btn btn-danger btn-xs" onclick="openRejectModal('${j.jobId}')">Reject</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

//  Row Actions 
window.jobOverrides = window.jobOverrides || {};

window.adjustJobCopies = function(jobId, delta) {
  window.jobOverrides[jobId] = window.jobOverrides[jobId] || {};
  let cur = window.jobOverrides[jobId].copies;
  if (cur === undefined) {
    const el = document.getElementById(`override-copies-${jobId}`);
    cur = el ? parseInt(el.innerText, 10) : 1;
  }
  const next = Math.max(1, Math.min(50, cur + delta));
  window.jobOverrides[jobId].copies = next;
  const el = document.getElementById(`override-copies-${jobId}`);
  if (el) el.innerText = next;
};

window.toggleJobColor = function(jobId) {
  window.jobOverrides[jobId] = window.jobOverrides[jobId] || {};
  let cur = window.jobOverrides[jobId].colorMode;
  if (!cur) {
    const btn = document.getElementById(`override-color-${jobId}`);
    cur = btn && btn.innerText.includes('Color') ? 'color' : 'monochrome';
  }
  const next = cur === 'color' ? 'monochrome' : 'color';
  window.jobOverrides[jobId].colorMode = next;
  const btn = document.getElementById(`override-color-${jobId}`);
  if (btn) {
    btn.className = `btn btn-xs ${next === 'color' ? 'btn-primary' : 'btn-secondary'}`;
    btn.innerText = next === 'color' ? 'Color' : 'Black & White';
  }
};

window.toggleJobStamp = function(jobId) {
  window.jobOverrides[jobId] = window.jobOverrides[jobId] || {};
  const cur = Boolean(window.jobOverrides[jobId].stampPaperMode);
  const next = !cur;
  window.jobOverrides[jobId].stampPaperMode = next;
  const btn = document.getElementById(`override-stamp-${jobId}`);
  if (btn) {
    btn.className = `btn btn-xs ${next ? 'btn-primary' : 'btn-secondary'}`;
    btn.innerText = next ? 'Stamp (3.5")' : 'Standard';
  }
};

window.sendWhatsAppReady = function(jobId, phone, pickupCode, amount) {
  let targetPhone = phone ? phone.trim().replace(/\D/g, '') : '';
  if (!targetPhone) {
    const input = window.prompt('Enter customer 10-digit WhatsApp number:', '');
    if (!input) return;
    targetPhone = input.trim().replace(/\D/g, '');
  }
  if (targetPhone.length === 10) targetPhone = '91' + targetPhone;
  const shopName = config.shopName || 'Print Station';
  const text = `Namaste! Your print job ${pickupCode} is ready for pickup at ${shopName}. Total: Rs. ${amount}. Thank you!`;
  const url = `https://wa.me/${targetPhone}?text=${encodeURIComponent(text)}`;
  window.electronAPI.openExternal(url);
  showToast(`WhatsApp message opened for ${pickupCode}`, 'success');
};

/** Shared helper: get cached download-url metadata for a job (or fetch if stale) */
async function _getJobDownloadMeta(jobId) {
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
  return apiFetch(`dlurl:${jobId}`, `${config.serverUrl}/api/agent/jobs/${jobId}/download-url`, { headers: hdr }, CACHE_TTL.dlurl);
}

window.printJobRow = async function(jobId) {
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.innerText = 'Printing...'; }

  try {
    // Uses cached presigned URL  no extra round-trip if viewed recently
    const meta = await _getJobDownloadMeta(jobId);
    const downloadUrls = meta.files.map(f => ({
      url: f.downloadUrl,
      filename: f.originalFilename,
      pageRange: f.pageRange,
      copies: f.copies,
      colorMode: f.colorMode
    }));
    const overrides = window.jobOverrides[jobId] || {};
    const effectivePrintOptions = Object.assign({}, meta.printOptions, overrides);
    const r = await window.electronAPI.printJob({ jobId, downloadUrls, printOptions: effectivePrintOptions });
    if (r.success) {
      showToast(`[PRINT] Job #${jobId.substring(0, 8)} sent to printer!`, 'success');
      logPrinterActivity(`Job #${jobId.substring(0, 8)} sent to printer`, 'blue');
      // Guarantee server marks job & linked order as COMPLETED so customer side updates immediately
      try {
        await apiFetch(`complete:${jobId}`, `${config.serverUrl}/api/vendor/jobs/${jobId}/complete`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.agentToken}`, 'Content-Type': 'application/json' }
        }, 0);
      } catch (_) {}
      invalidateCache('jobs', 'dashboard'); // force fresh stats after print
      refreshDashboard(true);
    } else {
      alert(`Print error: ${r.error || 'Failed to send to printer.'}`);
    }
  } catch (err) {
    alert(`Print error: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = 'Print'; }
  }
};

window.completeJobRow = async function(jobId) {
  try {
    await apiFetch(`complete:${jobId}`, `${config.serverUrl}/api/vendor/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.agentToken}`, 'Content-Type': 'application/json' }
    }, 0);
    showToast(`Job #${jobId.substring(0, 8)} marked Completed!`, 'success');
    logPrinterActivity(`Job #${jobId.substring(0, 8)} marked Completed`, 'green');
    invalidateCache('jobs', 'dashboard');
    refreshDashboard(true);
  } catch (err) {
    showToast(`Failed to mark complete: ${err.message}`, 'error');
  }
};

window.previewJobRow = async function(jobId) {
  try {
    // Uses cached presigned URL  no server call if already fetched
    const meta = await _getJobDownloadMeta(jobId);
    if (meta.files && meta.files[0]) {
      const f = meta.files[0];
      const r = await window.electronAPI.previewJob({
        fileUrl: f.downloadUrl,
        filename: f.originalFilename,
        jobId,
        index: 0
      });
      if (r && !r.success) {
        showToast(`Preview failed: ${r.error || 'Could not open file'}`, 'error');
      }
    } else {
      showToast('No files attached to this job', 'error');
    }
  } catch (err) {
    showToast(`Preview error: ${err.message}`, 'error');
  }
};

//  QR Page 
let _cachedQrData = null;
async function loadQR() {
  if (!config || !config.shopSlug) return;

  const img = document.getElementById('qr-image');
  const fallbackUrl = `${config.serverUrl}/shop/${config.shopSlug}`;

  // Instant render from memory cache if available for this shop
  if (_cachedQrData && _cachedQrData.shopSlug === config.shopSlug) {
    document.getElementById('qr-link-input').value = _cachedQrData.shopUrl || fallbackUrl;
    img.src = _cachedQrData.qrDataUrl;
    img.style.opacity = '1';
    img.alt = 'Store QR';
    return;
  }

  img.style.opacity = '0.4'; img.alt = 'Loading...';

  try {
    const res = await fetch(`${config.serverUrl}/api/shops/${config.shopSlug}/qr`);
    if (res.ok) {
      const data = await res.json();
      _cachedQrData = { ...data, shopSlug: config.shopSlug };
      document.getElementById('qr-link-input').value = data.shopUrl || fallbackUrl;
      if (data.qrDataUrl) {
        img.src = data.qrDataUrl;
        img.style.opacity = '1';
        img.alt = 'Store QR';
      }
    } else {
      document.getElementById('qr-link-input').value = fallbackUrl;
      img.alt = `QR error (${res.status})`;
      img.style.opacity = '1';
    }
  } catch (err) {
    document.getElementById('qr-link-input').value = fallbackUrl;
    img.alt = 'Server unreachable';
    img.style.opacity = '1';
  }
}

function printCounterPoster() {
  const qrSrc = document.getElementById('qr-image').src;
  const link  = document.getElementById('qr-link-input').value;
  const shop  = config.shopName || 'QrPrintDesk Counter';
  const win   = window.open('about:blank', '_blank', 'width=820,height=1000');
  if (!win) { window.electronAPI.openExternal(link); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>${shop}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px}.poster{border:3px solid #1e293b;border-radius:24px;padding:48px 40px;max-width:560px;width:100%;text-align:center}h1{font-size:32px;font-weight:800;color:#0f172a;margin-bottom:6px}h2{font-size:15px;font-weight:500;color:#2563eb;margin-bottom:28px}img.qr{width:280px;height:280px;border:2px solid #e2e8f0;border-radius:12px;padding:8px}.steps{margin:24px 0;text-align:left}.step{display:flex;align-items:center;gap:12px;padding:8px 0;font-size:15px;color:#334155;border-bottom:1px solid #f1f5f9}.step-num{background:#2563eb;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0}.url{font-size:12px;color:#64748b;font-family:monospace;margin-top:20px;word-break:break-all}@media print{body{padding:0}}</style>
</head><body><div class="poster">
<h1>${shop}</h1><h2>Instant Self-Service Cloud Printing</h2>
<img class="qr" src="${qrSrc}" />
<div class="steps">
  <div class="step"><span class="step-num">1</span>Open Camera on your mobile phone</div>
  <div class="step"><span class="step-num">2</span>Scan QR code to open our print store</div>
  <div class="step"><span class="step-num">3</span>Upload your files, choose options & pay</div>
  <div class="step"><span class="step-num">4</span>Collect fresh prints at the counter!</div>
</div>
<div class="url">${link}</div>
</div><script>window.onload=function(){window.print()}<\/script></body></html>`);
}

//  Printers 
async function loadPrinters() {
  try {
    const printers = await window.electronAPI.getPrinters();
    const selectSettings = document.getElementById('settings-printer-select');
    const selectSide     = document.getElementById('right-panel-printer-select');

    const currentSelected = config?.printerName || selectSide?.value || '';

    if (selectSettings) selectSettings.innerHTML = '<option value="">(Windows Default Printer)</option>';
    if (selectSide) selectSide.innerHTML = '<option value="">(Windows Default)</option>';

    let activePrinterStatus = 'Ready';
    let activeQueueCount = 0;

    printers.forEach(p => {
      const statusSuffix = p.status ? ` (${p.status})` : '';
      const label = `${p.displayName || p.name}${statusSuffix}${p.isDefault ? ' [Default]' : ''}`;
      const isThisSelected = currentSelected ? (p.name === currentSelected) : p.isDefault;

      if (selectSettings) {
        const opt1 = document.createElement('option');
        opt1.value = p.name;
        opt1.innerText = label;
        if (isThisSelected) {
          opt1.selected = true;
          activePrinterStatus = p.status || 'Ready';
          activeQueueCount = p.queueCount || 0;
        }
        selectSettings.appendChild(opt1);
      }

      if (selectSide) {
        const opt2 = document.createElement('option');
        opt2.value = p.name;
        opt2.innerText = `${p.displayName || p.name}${statusSuffix}`;
        if (isThisSelected) {
          opt2.selected = true;
          activePrinterStatus = p.status || 'Ready';
          activeQueueCount = p.queueCount || 0;
        }
        selectSide.appendChild(opt2);
      }
    });

    updatePrinterStatusBadge(activePrinterStatus, activeQueueCount);

    if (selectSettings) {
      selectSettings.onchange = () => {
        config.printerName = selectSettings.value;
        if (selectSide) selectSide.value = selectSettings.value;
        const match = printers.find(pr => pr.name === selectSettings.value);
        updatePrinterStatusBadge(match ? match.status : 'Ready', match ? match.queueCount : 0);
      };
    }

    if (selectSide) {
      selectSide.onchange = async () => {
        config.printerName = selectSide.value;
        if (selectSettings) selectSettings.value = selectSide.value;
        await window.electronAPI.saveConfig(config);
        const match = printers.find(pr => pr.name === selectSide.value);
        updatePrinterStatusBadge(match ? match.status : 'Ready', match ? match.queueCount : 0);
        showToast(`Printer set to: ${selectSide.value || 'Default'}`, 'info');
        logPrinterActivity(`Printer changed to: ${selectSide.value || 'Default'}`, 'blue');
      };
    }
  } catch (err) { console.error('Printers load failed:', err); }
}

function updatePrinterStatusBadge(status, queueCount = 0) {
  const settingsPill = document.getElementById('settings-printer-status-pill');
  const banner       = document.getElementById('right-printer-banner');
  const bannerText   = document.getElementById('right-printer-status-text');
  const bannerCheck  = document.getElementById('right-printer-check-icon');
  const bannerDesc   = document.getElementById('right-printer-desc');
  const specQueue    = document.getElementById('spec-queue-status');

  const clean = (status || 'Ready').toLowerCase();

  // ── Determine state ──────────────────────────────────────────────────────
  const isOffline   = clean.includes('offline');
  const isPaperOut  = clean.includes('paper') || clean.includes('tray');
  const isError     = clean.includes('error') || clean.includes('jam');
  const isBusy      = queueCount > 0 || clean.includes('printing') || clean.includes('queue');
  const isReady     = !isOffline && !isPaperOut && !isError;

  // ── Dot color & text for each state ─────────────────────────────────────
  const STATE = isOffline
    ? { dot: '#dc2626', dotPulse: true,  bg: '#fee2e2', textColor: '#b91c1c', label: 'Offline',          desc: `Printer offline — ${_printQueue.length + (_isPrinting ? 1 : 0)} job(s) safely held.` }
    : isPaperOut
    ? { dot: '#f97316', dotPulse: true,  bg: '#fff7ed', textColor: '#c2410c', label: 'Paper Empty',      desc: 'Add paper to resume printing automatically.' }
    : isError
    ? { dot: '#dc2626', dotPulse: true,  bg: '#fee2e2', textColor: '#b91c1c', label: 'Printer Error',    desc: 'Check printer screen for details.' }
    : isBusy
    ? { dot: '#3b82f6', dotPulse: true,  bg: '#eff6ff', textColor: '#1d4ed8', label: `Printing (${queueCount} in spool)`, desc: `Spooling ${queueCount} document(s) — ${_printQueue.length} more in app queue.` }
    : { dot: '#16a34a', dotPulse: false, bg: '#dcfce7', textColor: '#15803d', label: 'Ready',             desc: 'Printer is online and ready to print.' };

  // ── Settings pill ────────────────────────────────────────────────────────
  if (settingsPill) {
    settingsPill.innerHTML =
      `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STATE.dot};margin-right:5px;vertical-align:middle;${STATE.dotPulse ? 'animation:dotPulse 1.8s infinite;' : ''}"></span>` +
      (isOffline ? 'Offline' : isBusy ? `Printing (${queueCount})` : isPaperOut ? 'Paper Empty' : isError ? 'Error' : 'Ready');
    settingsPill.style.background  = STATE.bg;
    settingsPill.style.color       = STATE.textColor;
  }

  // ── Spooler queue pill ───────────────────────────────────────────────────
  if (specQueue) {
    if (queueCount > 0) {
      specQueue.className = 'spec-badge-ok blue';
      specQueue.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3b82f6;margin-right:4px;animation:dotPulse 1.8s infinite;vertical-align:middle;"></span> ${queueCount} Printing`;
    } else {
      specQueue.className = 'spec-badge-ok';
      specQueue.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#16a34a;margin-right:4px;vertical-align:middle;"></span> Ready`;
    }
  }

  // ── Right-panel banner ───────────────────────────────────────────────────
  if (banner) {
    banner.style.background    = STATE.bg;
    bannerText.innerText       = STATE.label;
    bannerText.style.color     = STATE.textColor;
    bannerCheck.style.background = STATE.dot;
    if (bannerDesc) bannerDesc.innerText = STATE.desc;
  }
}

//  Settings 
async function loadSettingsFromServer() {
  if (!config || !config.agentToken) return;
  try {
    // Reuse cached dashboard data (settings page just reads shop config)
    const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
    const data = await apiFetch('dashboard', `${config.serverUrl}/api/vendor/dashboard`, { headers: hdr }, CACHE_TTL.settings);

    if (data.shop) {
      if (document.getElementById('settings-shop-name')) document.getElementById('settings-shop-name').value = data.shop.name || config.shopName || '';
      if (document.getElementById('settings-owner-email')) document.getElementById('settings-owner-email').value = data.shop.ownerEmail || config.ownerEmail || '';
      if (document.getElementById('settings-shop-slug')) document.getElementById('settings-shop-slug').value = data.shop.slug || config.shopSlug || '';

      if (data.shop.pricing) {
        const p = data.shop.pricing;
        document.getElementById('settings-bw-price').value        = (p.bwPerPagePaise    / 100).toFixed(2);
        document.getElementById('settings-color-price').value     = (p.colorPerPagePaise / 100).toFixed(2);
        document.getElementById('settings-duplex-discount').value = (p.duplexDiscountPaise / 100).toFixed(2);
      }

      document.getElementById('settings-require-name').checked = data.shop.requireCustomerName === true;
      if (document.getElementById('settings-pay-counter')) {
        document.getElementById('settings-pay-counter').checked = data.shop.payAtCounter !== false;
      }
      if (document.getElementById('settings-enable-online')) {
        document.getElementById('settings-enable-online').checked = data.shop.enableOnlinePayment === true;
      }

      if (data.shop.printOptions) {
        const po = data.shop.printOptions;
        setCheck('opt-allow-bw',            po.allowBW);
        setCheck('opt-allow-color',         po.allowColor);
        setCheck('opt-allow-simplex',       po.allowSimplex);
        setCheck('opt-allow-duplex-long',   po.allowDuplexLong);
        setCheck('opt-allow-duplex-short',  po.allowDuplexShort);
        setCheck('opt-allow-portrait',      po.allowPortrait);
        setCheck('opt-allow-landscape',     po.allowLandscape);
        setCheck('opt-allow-2on1',          po.allow2on1);
        setSelectVal('opt-default-color',       po.defaultColorMode);
        setSelectVal('opt-default-duplex',      po.defaultDuplex);
        setSelectVal('opt-default-orientation', po.defaultOrientation);
        if (po.maxCopies) document.getElementById('settings-max-copies').value = po.maxCopies;
      }
    }
  } catch (e) { console.error('Load settings failed:', e); }
  loadEasySplitDetails();
  loadPrinters();
}

function setCheck(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = val !== false;
}

function setSelectVal(id, val) {
  const el = document.getElementById(id);
  if (el && val) el.value = val;
}

async function saveSettings() {
  const btn = document.getElementById('save-settings-btn');
  btn.disabled = true; btn.innerText = 'Saving...';

  config.printerName = document.getElementById('settings-printer-select').value;
  config.serverUrl   = document.getElementById('settings-server-url').value.trim();
  config.autoEnhance = document.getElementById('settings-auto-enhance').checked;
  config.soundAlert  = document.getElementById('settings-sound-alert').checked;

  const pacModeEl = document.getElementById('settings-pay-at-counter');
  const pacAutoEl = document.getElementById('settings-pac-autoprint');
  if (pacModeEl) config.payAtCounter = pacModeEl.checked;
  if (pacAutoEl) config.pacAutoPrint = pacAutoEl.checked;

  const bwPrice       = parseFloat(document.getElementById('settings-bw-price').value)       || 1.5;
  const colorPrice    = parseFloat(document.getElementById('settings-color-price').value)     || 5.0;
  const duplexDisc    = parseFloat(document.getElementById('settings-duplex-discount').value) || 0;
  const maxCopies     = parseInt(document.getElementById('settings-max-copies').value)        || 10;
  const requireName   = document.getElementById('settings-require-name').checked;

  const printOptions = {
    allowBW:            document.getElementById('opt-allow-bw').checked,
    allowColor:         document.getElementById('opt-allow-color').checked,
    allowSimplex:       document.getElementById('opt-allow-simplex').checked,
    allowDuplexLong:    document.getElementById('opt-allow-duplex-long').checked,
    allowDuplexShort:   document.getElementById('opt-allow-duplex-short').checked,
    allowPortrait:      document.getElementById('opt-allow-portrait').checked,
    allowLandscape:     document.getElementById('opt-allow-landscape').checked,
    allow2on1:          document.getElementById('opt-allow-2on1').checked,
    defaultColorMode:   document.getElementById('opt-default-color').value,
    defaultDuplex:      document.getElementById('opt-default-duplex').value,
    defaultOrientation: document.getElementById('opt-default-orientation').value,
    defaultPagesPerSheet: document.getElementById('opt-allow-2on1').checked ? 1 : 1,
    maxCopies,
  };

  if (!printOptions.allowBW && !printOptions.allowColor) {
    alert('At least one color mode (B&W or Color) must be enabled.');
    btn.disabled = false; btn.innerText = 'Save All Settings'; return;
  }
  if (!printOptions.allowSimplex && !printOptions.allowDuplexLong && !printOptions.allowDuplexShort) {
    alert('At least one duplex mode must be enabled.');
    btn.disabled = false; btn.innerText = 'Save All Settings'; return;
  }

  const updatedShopName = document.getElementById('settings-shop-name')?.value.trim();
  if (updatedShopName) config.shopName = updatedShopName;

  const updatedSlug = document.getElementById('settings-shop-slug')?.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    const res = await fetch(`${config.serverUrl}/api/vendor/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.agentToken}` },
      body: JSON.stringify({
        shopName:            updatedShopName || undefined,
        shopSlug:            updatedSlug || undefined,
        bwPerPagePaise:      Math.round(bwPrice    * 100),
        colorPerPagePaise:   Math.round(colorPrice * 100),
        duplexDiscountPaise: Math.round(duplexDisc * 100),
        requireCustomerName: requireName,
        payAtCounter:        document.getElementById('settings-pay-counter') ? document.getElementById('settings-pay-counter').checked : true,
        enableOnlinePayment: document.getElementById('settings-enable-online') ? document.getElementById('settings-enable-online').checked : false,
        printOptions
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }
    const resData = await res.json();
    if (resData.shop && resData.shop.slug) {
      config.shopSlug = resData.shop.slug;
    }
    await window.electronAPI.saveConfig(config);
    await saveEasySplitDetails();
    applyConfigUI();
    loadQR();
    showToast('Settings & Store URL saved!', 'success');
    logPrinterActivity('Shop settings & pricing updated', 'green');
  } catch (err) {
    showToast(`[ERROR] Save failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.innerText = 'Save All Settings';
  }
}

async function loadEasySplitDetails() {
  try {
    const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
    // 5-min cache  bank details don't change often
    const data = await apiFetch('easysplit', `${config.serverUrl}/api/vendor/easy-split`, { headers: hdr }, CACHE_TTL.easysplit);
    const statusBadge = document.getElementById('desktop-easysplit-status');
    const cutEl   = document.getElementById('desktop-easysplit-cut');
    const shareEl = document.getElementById('desktop-vendor-share');

    if (cutEl)   cutEl.textContent   = `${data.commissionPercent}%`;
    if (shareEl) shareEl.textContent = `${data.vendorSharePercent}%`;

    if (data.status === 'ACTIVE' && data.bankDetails) {
      if (statusBadge) {
        statusBadge.textContent = 'ACTIVE [AUTO-PAYOUTS ON]';
        statusBadge.style.background = '#dcfce7';
        statusBadge.style.color = '#15803d';
      }
      if (document.getElementById('desktop-bank-holder'))  document.getElementById('desktop-bank-holder').value  = data.bankDetails.accountHolder || '';
      if (document.getElementById('desktop-bank-account')) document.getElementById('desktop-bank-account').value = data.bankDetails.accountNumber || '';
      if (document.getElementById('desktop-bank-ifsc'))    document.getElementById('desktop-bank-ifsc').value    = data.bankDetails.ifsc || '';
      if (document.getElementById('desktop-bank-upi'))     document.getElementById('desktop-bank-upi').value     = data.bankDetails.upiId || '';
    } else {
      if (statusBadge) {
        statusBadge.textContent = 'NOT CONNECTED';
        statusBadge.style.background = '#fee2e2';
        statusBadge.style.color = '#ef4444';
      }
    }
  } catch (e) {
    console.error('Failed to load Easy Split details:', e);
  }
}

async function saveEasySplitDetails() {
  const holder = document.getElementById('desktop-bank-holder')?.value.trim();
  const account = document.getElementById('desktop-bank-account')?.value.trim();
  const ifsc = document.getElementById('desktop-bank-ifsc')?.value.trim();
  const upiId = document.getElementById('desktop-bank-upi')?.value.trim();

  if (account && ifsc && holder) {
    try {
      const res = await fetch(`${config.serverUrl}/api/vendor/easy-split/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.agentToken}` },
        body: JSON.stringify({ accountHolder: holder, accountNumber: account, ifsc, upiId })
      });
      if (res.ok) {
        const statusBadge = document.getElementById('desktop-easysplit-status');
        if (statusBadge) {
          statusBadge.textContent = 'ACTIVE [AUTO-PAYOUTS ON]';
          statusBadge.style.background = '#dcfce7';
          statusBadge.style.color = '#15803d';
        }
      }
    } catch (e) {
      console.warn('Easy split update failed:', e);
    }
  }
}

//  Setup / Auth Gate View 
function showSetupModal(show) {
  const gate = document.getElementById('auth-gate-container');
  const appContainer = document.getElementById('app-container');
  if (show) {
    if (gate) gate.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';
  } else {
    if (gate) gate.style.display = 'none';
    if (appContainer) appContainer.style.display = 'flex';
  }
}

async function handleRegister() {
  const shopName    = document.getElementById('reg-shop-name').value.trim();
  const ownerEmail  = document.getElementById('reg-owner-email').value.trim();
  const pin         = document.getElementById('reg-pin').value.trim();
  const stationName = document.getElementById('reg-station').value.trim();

  if (!shopName || !ownerEmail || !pin || !stationName) { alert('Please fill all fields.'); return; }
  if (!/^\d{4,8}$/.test(pin)) { alert('PIN must be 48 digits only.'); return; }

  const serverUrl = config.serverUrl || 'https://print.qrprintdesk.in';
  const btn = document.getElementById('submit-register-btn');
  btn.disabled = true; btn.innerText = 'Registering...';

  try {
    const res  = await fetch(`${serverUrl}/api/auth/vendor/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName, ownerEmail, pin, stationName })
    });
    const data = await res.json();
    if (!res.ok) { alert(`Registration failed: ${data.error || 'Server error'}`); return; }

    config = {
      serverUrl,
      agentToken: data.agentToken,
      agentId: data.agentId,
      shopId: data.shopId,
      shopSlug: data.shopSlug,
      shopName: data.shopName,
      ownerEmail: data.ownerEmail,
      stationName: data.stationName,
      autoPrint: true,
      soundAlert: true,
      autoEnhance: true,
      printerName: ''
    };
    await window.electronAPI.saveConfig(config);
    showSetupModal(false); applyConfigUI(); initWebSocket(); refreshDashboard(); loadPrinters(); loadQR(); startDashboardPolling();
    showToast('[OK] Shop registered! Station is now live.', 'success');
  } catch (err) { alert(`Connection error: ${err.message}\n\nMake sure the server is reachable.`); }
  finally { btn.disabled = false; btn.innerText = 'Create & Activate My Shop'; }
}

function toggleTokenLogin() {
  const container = document.getElementById('token-login-container');
  if (container) {
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
  }
}

async function handleEmailLogin() {
  const email       = document.getElementById('login-email').value.trim();
  const pin         = document.getElementById('login-pin').value.trim();
  const stationName = document.getElementById('login-station').value.trim() || 'Main Station';

  if (!email || !pin) { alert('Please enter your Registered Email and PIN.'); return; }
  if (!/^\d{4,8}$/.test(pin)) { alert('PIN must be 48 digits.'); return; }

  const serverUrl = config.serverUrl || 'https://print.qrprintdesk.in';
  const btn = document.getElementById('submit-login-btn');
  btn.disabled = true; btn.innerText = 'Signing In...';

  try {
    const res = await fetch(`${serverUrl}/api/auth/vendor/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin, stationName })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Sign in failed. Check credentials.'); return; }

    config = {
      serverUrl,
      agentToken: data.agentToken,
      agentId: data.agentId,
      shopId: data.shopId,
      shopSlug: data.shopSlug,
      shopName: data.shopName,
      ownerEmail: data.ownerEmail,
      stationName: data.stationName,
      autoPrint: true,
      soundAlert: true,
      autoEnhance: true,
      printerName: ''
    };
    await window.electronAPI.saveConfig(config);
    showSetupModal(false); applyConfigUI(); initWebSocket(); refreshDashboard(); loadPrinters(); loadQR(); startDashboardPolling();
    showToast(`Welcome back, ${data.shopName}!`, 'success');
  } catch (err) {
    alert(`Connection error: ${err.message}`);
  } finally {
    btn.disabled = false; btn.innerText = 'Sign In to My Shop';
  }
}

async function handleGoogleDesktopLogin() {
  const statusEl = document.getElementById('google-login-status');
  const btn = document.getElementById('google-login-btn');
  const regBtn = document.getElementById('google-reg-btn');
  if (btn) btn.disabled = true;
  if (regBtn) regBtn.disabled = true;
  if (statusEl) statusEl.style.display = 'block';

  try {
    const serverUrl = config.serverUrl || 'https://print.qrprintdesk.in';
    const res = await window.electronAPI.startGoogleAuth(serverUrl);
    if (res && res.success && res.authData) {
      const data = res.authData;
      config = {
        serverUrl,
        agentToken: data.agentToken,
        agentId: data.agentId,
        shopId: data.shopId,
        shopSlug: data.shopSlug,
        shopName: data.shopName,
        ownerEmail: data.ownerEmail,
        stationName: data.stationName || 'Main Counter',
        autoPrint: true,
        soundAlert: true,
        autoEnhance: true,
        printerName: config.printerName || ''
      };
      await window.electronAPI.saveConfig(config);
      showSetupModal(false);
      applyConfigUI();
      initWebSocket();
      refreshDashboard();
      loadPrinters();
      loadQR();
      startDashboardPolling();
      showToast(`Connected as ${data.shopName}!`, 'success');
    } else if (res && res.error) {
      showToast(res.error, 'error');
    }
  } catch (err) {
    showToast(`Google Sign-In error: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (regBtn) regBtn.disabled = false;
    if (statusEl) statusEl.style.display = 'none';
  }
}

async function cancelGoogleDesktopLogin() {
  try {
    await window.electronAPI.cancelGoogleAuth();
  } catch (_) {}
  const statusEl = document.getElementById('google-login-status');
  const btn = document.getElementById('google-login-btn');
  const regBtn = document.getElementById('google-reg-btn');
  if (btn) btn.disabled = false;
  if (regBtn) regBtn.disabled = false;
  if (statusEl) statusEl.style.display = 'none';
}

async function handleTokenLogin() {
  const serverUrl  = config.serverUrl || 'https://print.qrprintdesk.in';
  const agentToken = document.getElementById('login-agent-token').value.trim();
  if (!agentToken) { alert('Please enter Agent Token.'); return; }

  const btn = document.getElementById('submit-token-login-btn');
  btn.disabled = true; btn.innerText = 'Connecting...';

  try {
    const res = await fetch(`${serverUrl}/api/vendor/dashboard`, { headers: { 'Authorization': `Bearer ${agentToken}` } });
    if (!res.ok) { alert('Invalid agent token or server unreachable.'); return; }
    const data = await res.json();

    config = {
      serverUrl,
      agentToken,
      shopSlug: data.shop.slug,
      shopName: data.shop.name,
      autoPrint: true,
      soundAlert: true,
      autoEnhance: true,
      printerName: ''
    };
    await window.electronAPI.saveConfig(config);
    showSetupModal(false); applyConfigUI(); initWebSocket(); refreshDashboard(); loadPrinters(); loadQR(); startDashboardPolling();
    showToast(`[OK] Connected to ${data.shop.name}!`, 'success');
  } catch (err) { alert(`Connection error: ${err.message}`); }
  finally { btn.disabled = false; btn.innerText = 'Connect Station via Token'; }
}

async function handleLogout() {
  if (!confirm('Are you sure you want to sign out this vendor station?')) return;
  if (ws) {
    try { ws.close(); } catch (_) {}
  }
  if (dashboardPollTimer) clearInterval(dashboardPollTimer);
  config = {
    serverUrl: config.serverUrl || 'https://print.qrprintdesk.in',
    agentToken: '',
    shopSlug: '',
    shopName: '',
    autoPrint: true,
    soundAlert: true,
    autoEnhance: true,
    printerName: ''
  };
  await window.electronAPI.saveConfig(config);
  showSetupModal(true);
  showToast('Signed out of station.', 'info');
}

//  Utilities 
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 
// FINANCES, DETAILED ANALYTICS & EASY SPLIT MODULE
// 
let currentFinSubTab = 'analytics';
let currentAnalyticsPeriod = 'today';

window.switchFinSubTab = function(sub) {
  currentFinSubTab = sub;
  document.querySelectorAll('.fin-subnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-sub') === sub);
  });
  document.querySelectorAll('.fin-view-panel').forEach(p => {
    p.classList.toggle('active', p.id === `fin-panel-${sub}`);
  });

  if (sub === 'analytics') loadAnalytics(currentAnalyticsPeriod);
  if (sub === 'transactions') {
    loadEasySplitEarnings();
    loadTransactions();
    loadSettlements();
  }
  if (sub === 'easysplit') loadEasySplitDetails();
};

window.changeAnalyticsPeriod = function(period) {
  currentAnalyticsPeriod = period;
  document.querySelectorAll('.fin-period-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-period') === period);
  });
  loadAnalytics(period);
};

window.loadFinancesPage = function() {
  switchFinSubTab(currentFinSubTab);
};

async function loadAnalytics(period = 'today') {
  if (!config?.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };

  try {
    const data = await apiFetch(`analytics:${period}`, `${config.serverUrl}/api/vendor/analytics?period=${period}`, { headers: hdr }, 15000);
    if (!data) return;

    const s = data.summary || {};
    const v = data.volume || {};

    const elNet = document.getElementById('fin-net-earnings');
    const elGross = document.getElementById('fin-gross-revenue');
    const elOrders = document.getElementById('fin-total-orders');
    const elAvg = document.getElementById('fin-avg-order');
    const elVelocity = document.getElementById('fin-velocity');
    const elRepeat = document.getElementById('fin-repeat-customers');

    if (elNet) elNet.innerText = `Rs.${s.vendorShareRupees || '0.00'}`;
    if (elGross) elGross.innerText = `Rs.${s.grossRupees || '0.00'}`;
    if (elOrders) elOrders.innerText = s.totalOrders || 0;
    if (elAvg) elAvg.innerText = `Rs.${s.avgOrderRupees || '0.00'}`;
    if (elVelocity) elVelocity.innerText = `${data.xeroxMetrics?.pagesPerMinute || '0.00'} (${data.xeroxMetrics?.pagesPerHour || 0} pg/hr)`;
    if (elRepeat) elRepeat.innerText = `${data.customers?.returningRatePercent || 0}% (${data.customers?.returningCustomers || 0} repeat)`;

    // Hourly Rush Hours Multi-Bar Footfall
    const r = data.rushHours || {};
    const rushBadge = document.getElementById('fin-peak-rush-badge');
    if (rushBadge) {
      if (r.busiestHour >= 0 && r.peakOrdersCount > 0) {
        rushBadge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" style="vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Peak Rush: ${r.peakHourLabel} (${r.peakOrdersCount} orders)`;
      } else {
        rushBadge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" style="vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Steady Footfall';
      }
    }

    const hourlyContainer = document.getElementById('fin-hourly-bars');
    if (hourlyContainer && r.hourlyTrend) {
      const hData = r.hourlyTrend || [];
      const maxO = Math.max(1, ...hData.map(h => h.orders));
      const maxP = Math.max(1, ...hData.map(h => h.pages));

      hourlyContainer.innerHTML = hData.map(h => {
        const isPeak = h.hour === r.busiestHour && h.orders > 0;
        const ordH = Math.max(3, Math.round((h.orders / maxO) * 90));
        const pagH = Math.max(3, Math.round((h.pages / maxP) * 90));
        const barColor = isPeak ? '#f59e0b' : '#3b82f6';
        const pageColor = isPeak ? '#fbbf24' : '#10b981';

        return `
          <div style="flex:1;min-width:24px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;" title="${escHtml(h.label)}: ${h.orders} orders, ${h.pages} pages, Rs.${h.grossRupees}">
            <div style="width:100%;display:flex;gap:2px;align-items:flex-end;justify-content:center;height:100px;">
              <div style="width:7px;background:${barColor};height:${ordH}px;border-radius:2px 2px 0 0;"></div>
              <div style="width:7px;background:${pageColor};height:${pagH}px;border-radius:2px 2px 0 0;"></div>
            </div>
            <div style="font-size:9px;color:${isPeak ? '#d97706' : '#64748b'};font-weight:${isPeak ? '700' : '500'};margin-top:4px;white-space:nowrap;">${h.label.replace(' ', '')}</div>
          </div>
        `;
      }).join('');
    }

    // Volume Distribution
    const totalP = v.totalPages || (v.bwPages + v.colorPages) || 1;
    const bwPercent = Math.round(((v.bwPages || 0) / totalP) * 100);
    const colorPercent = 100 - bwPercent;

    const bwBar = document.getElementById('fin-bw-bar');
    const colorBar = document.getElementById('fin-color-bar');
    const bwTxt = document.getElementById('fin-bw-pages');
    const colorTxt = document.getElementById('fin-color-pages');

    if (bwBar) bwBar.style.width = `${bwPercent}%`;
    if (colorBar) colorBar.style.width = `${colorPercent}%`;
    if (bwTxt) bwTxt.innerText = `${v.bwPages || 0} pages (${bwPercent}%)`;
    if (colorTxt) colorTxt.innerText = `${v.colorPages || 0} pages (${colorPercent}%)`;

    // Duplex vs Simplex & Paper Saved
    const totalSheets = (v.duplexSheets + v.simplexSheets) || 1;
    const dupPercent = Math.round(((v.duplexSheets || 0) / totalSheets) * 100);
    const simpPercent = 100 - dupPercent;

    const dupBar = document.getElementById('fin-duplex-bar');
    const simpBar = document.getElementById('fin-simplex-bar');
    const dupTxt = document.getElementById('fin-duplex-sheets');
    const savedTxt = document.getElementById('fin-saved-sheets');

    if (dupBar) dupBar.style.width = `${dupPercent}%`;
    if (simpBar) simpBar.style.width = `${simpPercent}%`;
    if (dupTxt) dupTxt.innerText = `${v.duplexSheets || 0} sheets (${dupPercent}%)`;
    if (savedTxt) savedTxt.innerText = `${v.paperSheetsSaved || 0} sheets (${data.xeroxMetrics?.duplexSavePercent || 0}%)`;

    // Payment Collection Mode
    const pmt = data.payments || {};
    const totPay = (pmt.counterCashOrders + pmt.onlineUpiOrders) || 1;
    const cashPct = Math.round((pmt.counterCashOrders / totPay) * 100);
    const upiPct = 100 - cashPct;

    const cashBar = document.getElementById('fin-cash-bar');
    const upiBar = document.getElementById('fin-upi-bar');
    const cashTxt = document.getElementById('fin-cash-text');
    const upiTxt = document.getElementById('fin-upi-text');

    if (cashBar) cashBar.style.width = `${cashPct}%`;
    if (upiBar) upiBar.style.width = `${upiPct}%`;
    if (cashTxt) cashTxt.innerText = `Rs.${pmt.counterCashRupees || '0.00'} (${pmt.counterCashOrders || 0})`;
    if (upiTxt) upiTxt.innerText = `Rs.${pmt.onlineUpiRupees || '0.00'} (${pmt.onlineUpiOrders || 0})`;

    // 7-day table (now with pages column)
    const dailyTbody = document.getElementById('fin-daily-tbody');
    if (dailyTbody) {
      const rows = data.dailyTrend || [];
      if (rows.length === 0) {
        dailyTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px;">No historical orders yet.</td></tr>';
      } else {
        dailyTbody.innerHTML = rows.map(r => `
          <tr>
            <td style="font-weight:600;">${escHtml(r.date)}</td>
            <td><strong style="color:#0f172a;">${r.orders}</strong> orders</td>
            <td><strong style="color:#6366f1;">${r.totalPages || 0}</strong> pg</td>
            <td>Rs.${r.grossRupees}</td>
            <td style="color:#16a34a;font-weight:700;">Rs.${r.vendorShareRupees}</td>
          </tr>
        `).join('');
      }
    }

    // Fetch and render monthly archive
    try {
      const mdata = await apiFetch('analytics:monthly', `${config.serverUrl}/api/vendor/analytics/monthly`, { headers: hdr }, 15000);
      const monthlyTbody = document.getElementById('fin-monthly-tbody');
      if (monthlyTbody && mdata) {
        const months = mdata.months || [];
        if (months.length === 0) {
          monthlyTbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:20px;">No monthly data yet. Data accumulates as orders are processed.</td></tr>';
        } else {
          monthlyTbody.innerHTML = months.map(m => `
            <tr>
              <td style="font-weight:700;">${escHtml(m.yearMonth)}</td>
              <td>${m.totalOrders}</td>
              <td>${m.totalPages || 0}</td>
              <td style="color:#475569;">${m.bwPages}</td>
              <td style="color:#2563eb;">${m.colorPages}</td>
              <td>Rs.${m.grossRupees}</td>
              <td style="color:#16a34a;font-weight:700;">Rs.${m.vendorShareRupees}</td>
            </tr>
          `).join('');
        }
      }
    } catch (mErr) {
      console.warn('Monthly analytics fetch error:', mErr);
    }
  } catch (err) {
    console.error('loadAnalytics error:', err);
  }
}

async function loadEasySplitEarnings() {
  if (!config?.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };

  try {
    const data = await apiFetch('easysplit:earnings', `${config.serverUrl}/api/vendor/easy-split/earnings`, { headers: hdr }, 15000);
    if (!data) return;

    const elPending = document.getElementById('fin-pending-settlement');
    const elSettled = document.getElementById('fin-settled-to-bank');
    const elTotal = document.getElementById('fin-total-alltime');

    if (elPending) elPending.innerText = `Rs.${data.pendingSettlementRupees || '0.00'}`;
    if (elSettled) elSettled.innerText = `Rs.${data.settledToBankRupees || '0.00'}`;
    if (elTotal) elTotal.innerText = `Rs.${data.totalEarningsRupees || '0.00'}`;
  } catch (err) {
    console.error('loadEasySplitEarnings error:', err);
  }
}

window.loadTransactions = async function(force = false) {
  if (!config?.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
  const tbody = document.getElementById('fin-transactions-tbody');
  if (force && tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-dim);">Refreshing transactions...</td></tr>';

  try {
    const ttl = force ? 0 : 30000;
    const data = await apiFetch('transactions', `${config.serverUrl}/api/vendor/transactions?limit=40`, { headers: hdr }, ttl);
    const txns = data?.transactions || [];

    if (!tbody) return;
    if (txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:30px;">No transactions found in ledger yet.</td></tr>';
      return;
    }

    tbody.innerHTML = txns.map(t => {
      const dt = t.date ? new Date(t.date).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '-';
      const settledBadge = t.settled
        ? '<span class="badge completed">SETTLED</span>'
        : '<span class="badge queued" title="Scheduled for T+1 morning payout">T+1 PENDING</span>';

      return `<tr>
        <td><span class="pickup-badge">${escHtml(t.pickupCode || '-')}</span></td>
        <td><code style="font-size:11px;">${t.orderId ? t.orderId.substring(0, 14) : '-'}</code></td>
        <td style="font-weight:600;">${escHtml(t.customerName)}</td>
        <td>${t.pageCount} p. (${t.colorMode === 'color' ? 'Color' : 'BW'})</td>
        <td>Rs.${t.grossRupees}</td>
        <td style="color:var(--text-muted);">Rs.${t.platformFeeRupees}</td>
        <td style="font-weight:700;color:#16a34a;">Rs.${t.vendorShareRupees}</td>
        <td style="font-size:11.5px;color:var(--text-dim);">${dt}</td>
        <td>${settledBadge}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ef4444;padding:20px;">Failed to load transactions: ${err.message}</td></tr>`;
  }
};

window.loadSettlements = async function(force = false) {
  if (!config?.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
  const tbody = document.getElementById('fin-settlements-tbody');
  if (force && tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-dim);">Refreshing payouts...</td></tr>';

  try {
    const ttl = force ? 0 : 30000;
    const data = await apiFetch('settlements', `${config.serverUrl}/api/vendor/easy-split/settlements?limit=30`, { headers: hdr }, ttl);
    const sets = data?.settlements || [];

    if (!tbody) return;
    if (sets.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px;">No automated bank transfers recorded yet. Payouts trigger automatically via T+1 schedule.</td></tr>';
      return;
    }

    tbody.innerHTML = sets.map(s => {
      const dt = s.date ? new Date(s.date).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '-';
      const st = (s.status || 'INITIATED').toLowerCase();
      const badge = `<span class="badge ${st === 'success' ? 'completed' : st === 'failed' ? 'failed' : 'queued'}">${s.status}</span>`;

      return `<tr>
        <td><code style="font-size:11px;">${s.settlementId}</code></td>
        <td style="font-weight:700;color:#16a34a;">Rs.${Number(s.amountRupees).toFixed(2)}</td>
        <td><span style="font-family:monospace;font-size:12px;">${escHtml(s.transferRemark || 'Auto-payout T+1')}</span></td>
        <td>${badge}</td>
        <td style="font-size:11.5px;color:var(--text-dim);">${dt}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">Failed to load payouts: ${err.message}</td></tr>`;
  }
};

async function loadEasySplitDetails() {
  if (!config?.agentToken) return;
  const hdr = { 'Authorization': `Bearer ${config.agentToken}` };

  try {
    const data = await apiFetch('easysplit:info', `${config.serverUrl}/api/vendor/easy-split`, { headers: hdr }, 15000);
    if (!data) return;

    const b = data.bankDetails || {};
    const k = data.kycDetails || {};
    const docs = data.kycDocuments || {};

    const elHolder = document.getElementById('es-holder');
    const elAcc = document.getElementById('es-account');
    const elAccConf = document.getElementById('es-account-confirm');
    const elIfsc = document.getElementById('es-ifsc');
    const elUpi = document.getElementById('es-upi');
    const elPan = document.getElementById('es-pan');
    const elType = document.getElementById('es-account-type');
    const elGst = document.getElementById('es-gst');
    const elBiz = document.getElementById('es-biz-name');

    if (elHolder && b.accountHolder) elHolder.value = b.accountHolder;
    if (elAcc && b.accountNumber) {
      elAcc.value = b.accountNumber;
      if (elAccConf) elAccConf.value = b.accountNumber;
    }
    if (elIfsc && b.ifsc) elIfsc.value = b.ifsc;
    if (elUpi && b.upiId) elUpi.value = b.upiId;
    if (elPan && k.pan) elPan.value = k.pan;
    if (elType && k.accountType) elType.value = k.accountType;
    if (elGst && k.gst) elGst.value = k.gst;
    if (elBiz && k.businessName) elBiz.value = k.businessName;

    // Status Banner
    const isAct = data.status === 'ACTIVE';
    const badge = document.getElementById('fin-es-badge');
    const title = document.getElementById('fin-es-status-title');
    const desc = document.getElementById('fin-es-status-desc');
    const banner = document.getElementById('fin-es-status-banner');

    if (badge) {
      badge.className = `badge ${isAct ? 'completed' : 'queued'}`;
      badge.innerText = data.status;
    }
    if (title) title.innerText = isAct ? 'Easy Split: ACTIVE (Auto-Payouts Enabled)' : 'Easy Split: PENDING VERIFICATION';
    if (desc) {
      desc.innerText = isAct
        ? `95% of customer payments settle automatically to ${b.accountHolder || 'your account'} (A/C: ${b.accountNumber ? '****' + b.accountNumber.slice(-4) : '-'}, IFSC: ${b.ifsc || '-'}).`
        : 'Please fill in your bank details and upload your KYC documents to activate automated payouts.';
    }
    if (banner) {
      banner.style.background = isAct ? '#f0fdf4' : '#fffbeb';
      banner.style.borderColor = isAct ? '#bbf7d0' : '#fde68a';
    }

    // Document statuses
    if (docs.bank_proof) {
      const lbl = document.getElementById('kyc-bank-label');
      const st = document.getElementById('kyc-bank-status');
      if (lbl) lbl.innerText = `Uploaded: ${docs.bank_proof.filename}`;
      if (st) {
        st.style.display = 'block';
        st.innerText = `[OK] Verified Passbook / Cheque (${Math.round(docs.bank_proof.size / 1024)} KB)`;
      }
    }
    if (docs.pan_card) {
      const lbl = document.getElementById('kyc-pan-label');
      const st = document.getElementById('kyc-pan-status');
      if (lbl) lbl.innerText = `Uploaded: ${docs.pan_card.filename}`;
      if (st) {
        st.style.display = 'block';
        st.innerText = `[OK] Verified PAN Card (${Math.round(docs.pan_card.size / 1024)} KB)`;
      }
    }
  } catch (err) {
    console.error('loadEasySplitDetails error:', err);
  }
}

window.saveEasySplitKYC = async function() {
  const holder = document.getElementById('es-holder')?.value.trim();
  const acc = document.getElementById('es-account')?.value.trim();
  const accConf = document.getElementById('es-account-confirm')?.value.trim();
  const ifsc = document.getElementById('es-ifsc')?.value.trim().toUpperCase();
  const upi = document.getElementById('es-upi')?.value.trim();
  const pan = document.getElementById('es-pan')?.value.trim().toUpperCase();
  const accountType = document.getElementById('es-account-type')?.value;
  const gst = document.getElementById('es-gst')?.value.trim().toUpperCase();
  const businessName = document.getElementById('es-biz-name')?.value.trim();

  if (!holder || !acc || !ifsc || !pan) {
    showToast('Please fill in all required fields (Account Holder, Account No, IFSC, PAN).', 'error');
    return;
  }
  if (acc !== accConf) {
    showToast('Account numbers do not match. Please verify.', 'error');
    return;
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    showToast('Invalid IFSC Code. Must be exactly 11 characters (e.g. SBIN0001234).', 'error');
    return;
  }
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
    showToast('Invalid PAN format. Must be 10 characters (e.g. ABCDE1234F).', 'error');
    return;
  }

  const btn = document.getElementById('fin-save-kyc-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Connecting with Cashfree...';
  }

  try {
    const res = await fetch(`${config.serverUrl}/api/vendor/easy-split/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.agentToken}`
      },
      body: JSON.stringify({
        accountHolder: holder,
        accountNumber: acc,
        ifsc,
        upiId: upi || undefined,
        pan,
        accountType: accountType || 'INDIVIDUAL',
        businessName: businessName || holder,
        gst: gst || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save bank details');

    invalidateCache('easysplit:info', 'easysplit:earnings');
    showToast('Bank details connected and verified with Cashfree Easy Split!', 'success');
    loadEasySplitDetails();
  } catch (err) {
    showToast(`[ERROR] Registration Error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Save & Verify with Cashfree Easy Split';
    }
  }
};

window.uploadKYCDocument = async function(docType, inputEl) {
  if (!inputEl?.files || inputEl.files.length === 0) return;
  const file = inputEl.files[0];

  const formData = new FormData();
  formData.append('file', file);
  formData.append('docType', docType);

  showToast(`Uploading ${docType.replace('_', ' ')}...`, 'info');

  try {
    const res = await fetch(`${config.serverUrl}/api/vendor/easy-split/upload-kyc`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.agentToken}`
      },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    showToast(`[OK] ${data.message || 'Document uploaded successfully!'}`, 'success');
    invalidateCache('easysplit:info');
    loadEasySplitDetails();
  } catch (err) {
    showToast(`[ERROR] Document Upload Error: ${err.message}`, 'error');
  }
};

// ── Subscription & Billing Quota ──────────────────────────────────────────
async function loadSubscriptionFromServer(force = false) {
  if (!config || !config.agentToken) return;
  try {
    const hdr = { 'Authorization': `Bearer ${config.agentToken}` };
    const res = await fetch(`${config.serverUrl}/api/vendor/subscription`, { headers: hdr });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.subscription) return;

    const sub = data.subscription;
    const planConfig = data.planConfig || {};
    const usagePct = Math.min(100, Math.max(0, data.usagePercent || 0));

    // Update Plan Name and Badge
    const planNameEl = document.getElementById('sub-plan-name');
    if (planNameEl) planNameEl.textContent = planConfig.name || sub.plan;

    const badgeTextEl = document.getElementById('sub-plan-badge-text');
    if (badgeTextEl) badgeTextEl.textContent = `Active Plan: ${sub.plan}`;

    const statusTagEl = document.getElementById('sub-status-tag');
    if (statusTagEl) {
      statusTagEl.textContent = sub.status === 'TRIAL' ? 'Active Trial' : 'Active Subscription';
      statusTagEl.style.background = sub.status === 'TRIAL' ? '#dcfce7' : '#eff6ff';
      statusTagEl.style.color = sub.status === 'TRIAL' ? '#166534' : '#1e40af';
      statusTagEl.style.borderColor = sub.status === 'TRIAL' ? '#bbf7d0' : '#bfdbfe';
    }

    // Progress Bar
    const progressBar = document.getElementById('sub-progress-bar');
    if (progressBar) {
      progressBar.style.width = `${usagePct}%`;
      if (usagePct >= 100) progressBar.style.background = '#dc2626';
      else if (usagePct >= 80) progressBar.style.background = '#d97706';
      else progressBar.style.background = '#2563eb';
    }

    const usageTextEl = document.getElementById('sub-usage-text');
    if (usageTextEl) {
      const limitStr = sub.monthlyOrderLimit >= 999999 ? 'Unlimited' : sub.monthlyOrderLimit;
      usageTextEl.textContent = `${sub.ordersThisMonth || 0} / ${limitStr} orders (${usagePct}%)`;
    }

    // Stat tiles
    const statUsed = document.getElementById('sub-stat-used');
    if (statUsed) statUsed.textContent = `${sub.ordersThisMonth || 0} Orders`;

    const statLimit = document.getElementById('sub-stat-limit');
    if (statLimit) statLimit.textContent = sub.monthlyOrderLimit >= 999999 ? 'Unlimited' : `${sub.monthlyOrderLimit} Orders`;

    const statRemaining = document.getElementById('sub-stat-remaining');
    if (statRemaining) {
      if (sub.monthlyOrderLimit >= 999999) {
        statRemaining.textContent = 'Unlimited';
      } else {
        const remaining = Math.max(0, sub.monthlyOrderLimit - (sub.ordersThisMonth || 0));
        statRemaining.textContent = `${remaining} Prints`;
      }
    }

    const statGrace = document.getElementById('sub-stat-grace');
    if (statGrace) {
      const grace = sub.graceOrdersAllowed ?? 10;
      statGrace.textContent = `+${grace} Prints`;
    }

    // Quota alert banner
    const alertBanner = document.getElementById('sub-alert-banner');
    if (alertBanner) {
      if (data.isLimitReached) {
        alertBanner.style.display = 'block';
        alertBanner.style.background = '#fef2f2';
        alertBanner.style.borderColor = '#fecaca';
        alertBanner.style.color = '#991b1b';
        alertBanner.textContent = `Monthly quota reached (${sub.ordersThisMonth}/${sub.monthlyOrderLimit}). Grace buffer prints are active to ensure counter never stops.`;
      } else if (data.isNearLimit) {
        alertBanner.style.display = 'block';
        alertBanner.style.background = '#fffbeb';
        alertBanner.style.borderColor = '#fef3c7';
        alertBanner.style.color = '#92400e';
        alertBanner.textContent = `Notice: You have used ${usagePct}% of your monthly print quota (${sub.ordersThisMonth}/${sub.monthlyOrderLimit}).`;
      } else {
        alertBanner.style.display = 'none';
      }
    }

    // Sidebar quota pill
    const sidebarQuotaText = document.getElementById('sidebar-quota-text');
    if (sidebarQuotaText) {
      const limitStr = sub.monthlyOrderLimit >= 999999 ? 'Unl.' : sub.monthlyOrderLimit;
      sidebarQuotaText.textContent = `${sub.ordersThisMonth || 0} / ${limitStr}`;
      if (usagePct >= 100) sidebarQuotaText.style.color = '#dc2626';
      else if (usagePct >= 80) sidebarQuotaText.style.color = '#d97706';
      else sidebarQuotaText.style.color = '#2563eb';
    }

    // Connected shop slug
    const shopSlugEl = document.getElementById('sub-shop-slug');
    if (shopSlugEl) shopSlugEl.textContent = config.shopSlug || 'default';

  } catch (err) {
    console.error('Failed to load subscription status:', err);
  }
}

function openWebBillingPortal(planId) {
  if (!config || !config.serverUrl) return;
  const baseUrl = config.serverUrl.replace(/\/+$/, '');
  const slug = encodeURIComponent(config.shopSlug || 'default');
  let url = `${baseUrl}/vendor-portal.html?tab=plans&shop=${slug}`;
  if (planId) url += `&upgrade=${encodeURIComponent(planId)}`;
  window.electronAPI.openExternal(url);
}

window.openWebBillingPortal = openWebBillingPortal;
window.loadSubscriptionFromServer = loadSubscriptionFromServer;
