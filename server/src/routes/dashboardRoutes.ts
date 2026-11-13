import { FastifyPluginAsync } from 'fastify';
import { Db, ObjectId } from 'mongodb';
import { ShopDocument, JobDocument, OrderDocument, LedgerDocument } from '../types.js';
import { WebSocketHub } from '../services/wsHub.js';

export const dashboardRoutes: FastifyPluginAsync<{ db: Db; wsHub?: WebSocketHub }> = async (fastify, opts) => {
  const db = opts.db;
  const wsHub = opts.wsHub;

  // JSON summary API for dashboard stats
  fastify.get('/api/status/summary', async (request, reply) => {
    let mongoConnected = false;
    try {
      await db.command({ ping: 1 });
      mongoConnected = true;
    } catch (_) {}

    const activeShopIds = wsHub?.getActiveShopIds() || [];
    const activeAgentsCount = wsHub?.getActiveAgentCount() || 0;

    const [
      totalOrders,
      ordersByStatus,
      totalJobs,
      jobsByStatus,
      shops,
      recentJobs,
      ledgerSummary
    ] = await Promise.all([
      db.collection('orders').countDocuments({}),
      db.collection('orders').aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).toArray(),
      db.collection('jobs').countDocuments({}),
      db.collection('jobs').aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).toArray(),
      db.collection<ShopDocument>('shops').find({}).toArray(),
      db.collection<JobDocument>('jobs').find({}).sort({ updatedAt: -1 }).limit(25).toArray(),
      db.collection<LedgerDocument>('ledger').aggregate([
        {
          $group: {
            _id: null,
            totalGrossPaise: { $sum: '$grossPaise' },
            totalPlatformFeePaise: { $sum: '$platformFeePaise' },
            totalVendorSharePaise: { $sum: '$vendorSharePaise' }
          }
        }
      ]).toArray()
    ]);

    const orderStatusMap: Record<string, number> = {};
    for (const item of ordersByStatus) {
      orderStatusMap[item._id] = item.count;
    }

    const jobStatusMap: Record<string, number> = {};
    for (const item of jobsByStatus) {
      jobStatusMap[item._id] = item.count;
    }

    const grossRevenuePaise = ledgerSummary[0]?.totalGrossPaise || 0;
    const vendorSharePaise = ledgerSummary[0]?.totalVendorSharePaise || 0;

    return reply.send({
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      mongoConnected,
      activeAgentsCount,
      activeShopIds,
      stats: {
        totalOrders,
        queued: jobStatusMap['QUEUED'] || 0,
        downloading: jobStatusMap['DOWNLOADING'] || 0,
        printSubmitted: jobStatusMap['PRINT_SUBMITTED'] || 0,
        completed: jobStatusMap['COMPLETED'] || 0,
        manualReview: jobStatusMap['MANUAL_REVIEW'] || 0,
        failed: (jobStatusMap['FAILED'] || 0) + (orderStatusMap['FAILED'] || 0),
        revenueRupees: (grossRevenuePaise / 100).toFixed(2),
        vendorShareRupees: (vendorSharePaise / 100).toFixed(2)
      },
      shops: shops.map((s) => ({
        id: s._id.toString(),
        name: s.name,
        slug: s.slug,
        bwPerPage: ((s.pricing?.bwPerPagePaise || 200) / 100).toFixed(2),
        colorPerPage: ((s.pricing?.colorPerPagePaise || 1000) / 100).toFixed(2),
        isActive: s.isActive,
        isAgentConnected: activeShopIds.includes(s._id.toString())
      })),
      recentJobs: recentJobs.map((j) => ({
        jobId: j.jobId,
        orderId: j.orderId,
        shopId: j.shopId.toString(),
        status: j.status,
        retryCount: j.retryCount,
        failureReason: j.failureReason,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt
      }))
    });
  });

  // Admin Web Dashboard HTML View
  fastify.get('/status', async (request, reply) => {
    reply.type('text/html');
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QrPrintDesk Cloud Control Plane - Live Status</title>
  <style>
    :root {
      --bg: #0b1120;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #3b82f6;
      --green: #10b981;
      --yellow: #f59e0b;
      --red: #ef4444;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    body { background: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 700; color: #fff; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .badge-online { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-offline { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .card-title { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; letter-spacing: 0.5px; }
    .card-value { font-size: 26px; font-weight: 700; color: #fff; }
    .card-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .val-green { color: #34d399; }
    .val-yellow { color: #fbbf24; }
    .val-primary { color: #60a5fa; }
    .val-purple { color: #a78bfa; }

    .section-title { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
    th { padding: 10px 14px; background: rgba(0,0,0,0.2); color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); }
    td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .status-pill { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .st-QUEUED { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .st-DOWNLOADING { background: rgba(139, 92, 246, 0.2); color: #c084fc; }
    .st-PRINT_SUBMITTED { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .st-COMPLETED { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .st-MANUAL_REVIEW { background: rgba(239, 68, 68, 0.25); color: #f87171; }
    .st-FAILED { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    
    .btn {
      padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--border);
      background: #334155; color: #fff; font-weight: 600; transition: all 0.15s; text-decoration: none;
    }
    .btn:hover { background: #475569; }
    .btn-requeue { background: #0284c7; border-color: #0369a1; }
    .btn-requeue:hover { background: #0369a1; }
    .btn-cancel { background: #dc2626; border-color: #b91c1c; }
    .btn-cancel:hover { background: #b91c1c; }
    .controls { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>QrPrintDesk Cloud Control Plane</h1>
        <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">Zero-Touch Local Photocopy Server & Job Routing Hub</div>
      </div>
      <div class="controls">
        <span id="mongoBadge" class="badge badge-online"><span class="pulse"></span> MongoDB Connected</span>
        <button class="btn" onclick="fetchSummary()">Refresh Now</button>
        <label><input type="checkbox" id="autoRefresh" checked onchange="toggleAutoRefresh(this.checked)"> Auto 5s</label>
      </div>
    </header>

    <!-- Prominent Customer Scan & Print Banner -->
    <div style="background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 12px; padding: 18px 24px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 18px;">
      <div style="display: flex; align-items: center; gap: 18px;">
        <div style="background: #fff; padding: 6px; border-radius: 8px;">
          <img id="shopQrImg" style="width: 84px; height: 84px; display: block;" alt="Customer Scan QR">
        </div>
        <div>
          <div style="font-size: 16px; font-weight: 800; color: #fff;">Customer Self-Print QR Code (Scan to Pay & Print)</div>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Customers scan this code on their mobile to upload files, pay via Cashfree, and print instantly.</div>
          <div style="margin-top: 6px; font-size: 13px; color: #38bdf8;" id="customerUrlText">Loading link...</div>
        </div>
      </div>
      <div>
        <a id="openCustomerLink" href="/shop/default" target="_blank" class="btn" style="background: #2563eb; color: #fff; padding: 10px 18px; font-size: 13px;">
          ðŸ“± Open Customer Print Page
        </a>
      </div>
    </div>

    <!-- Stat Cards -->
    <div class="grid">
      <div class="card">
        <div class="card-title">Queued Jobs</div>
        <div class="card-value val-primary" id="queuedCount">-</div>
        <div class="card-sub">Waiting for agent</div>
      </div>
      <div class="card">
        <div class="card-title">Active Prints</div>
        <div class="card-value val-purple" id="activePrintsCount">-</div>
        <div class="card-sub">Downloading / Spooling</div>
      </div>
      <div class="card">
        <div class="card-title">Manual Review</div>
        <div class="card-value val-yellow" id="reviewCount">-</div>
        <div class="card-sub">Needs shopkeeper check</div>
      </div>
      <div class="card">
        <div class="card-title">Completed</div>
        <div class="card-value val-green" id="completedCount">-</div>
        <div class="card-sub">Printed successfully</div>
      </div>
      <div class="card">
        <div class="card-title">Total Revenue</div>
        <div class="card-value val-green" id="revenueCount">â‚¹0.00</div>
        <div class="card-sub" id="vendorShareCount">Shop: â‚¹0.00</div>
      </div>
      <div class="card">
        <div class="card-title">Registered Shops</div>
        <div class="card-value" id="shopsCount">-</div>
        <div class="card-sub" id="uptimeDisplay">Uptime: -</div>
      </div>
    </div>

    <!-- Active Shops Section -->
    <div class="section-title">Registered Print Shops</div>
    <div class="card" style="margin-bottom: 28px; padding: 0; overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>Shop Name</th>
            <th>Slug</th>
            <th>B&W Rate</th>
            <th>Color Rate</th>
            <th>Station Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="shopsTableBody">
          <tr><td colspan="6" style="text-align:center; color:var(--muted);">Loading shops...</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Recent Jobs Live Monitor -->
    <div class="section-title">
      <span>Live Print Jobs</span>
      <span style="font-size: 12px; color: var(--muted);" id="lastUpdated">Updated just now</span>
    </div>
    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Order ID</th>
            <th>Status</th>
            <th>Last Updated</th>
            <th>Failure / Review Note</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="jobsTableBody">
          <tr><td colspan="6" style="text-align:center; color:var(--muted);">Loading jobs...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    let timer = null;

    async function loadShopQr() {
      try {
        const res = await fetch('/api/shops/default/qr');
        if (res.ok) {
          const data = await res.json();
          document.getElementById('shopQrImg').src = data.qrDataUrl;
          document.getElementById('customerUrlText').textContent = data.shopUrl;
          document.getElementById('openCustomerLink').href = data.shopUrl;
        }
      } catch (_) {}
    }

    async function fetchSummary() {
      try {
        const res = await fetch('/api/status/summary');
        if (!res.ok) throw new Error('Failed to load status');
        const data = await res.json();

        // Update badges & header
        const mongoBadge = document.getElementById('mongoBadge');
        if (data.mongoConnected) {
          mongoBadge.className = 'badge badge-online';
          mongoBadge.innerHTML = '<span class="pulse"></span> MongoDB Connected';
        } else {
          mongoBadge.className = 'badge badge-offline';
          mongoBadge.innerHTML = '<span class="pulse"></span> MongoDB Disconnected';
        }

        // Update Stat Cards
        document.getElementById('queuedCount').textContent = data.stats.queued;
        document.getElementById('activePrintsCount').textContent = (data.stats.downloading + data.stats.printSubmitted);
        document.getElementById('reviewCount').textContent = data.stats.manualReview;
        document.getElementById('completedCount').textContent = data.stats.completed;
        document.getElementById('revenueCount').textContent = 'â‚¹' + data.stats.revenueRupees;
        document.getElementById('vendorShareCount').textContent = 'Shop Share: â‚¹' + data.stats.vendorShareRupees;
        document.getElementById('shopsCount').textContent = (data.shops || []).length;

        // Uptime formatting
        const uptimeMin = Math.floor(data.uptimeSeconds / 60);
        document.getElementById('uptimeDisplay').textContent = 'Uptime: ' + uptimeMin + ' mins';
        document.getElementById('lastUpdated').textContent = 'Updated: ' + new Date().toLocaleTimeString();

        // Render Shops Table
        const shopsTbody = document.getElementById('shopsTableBody');
        if (!data.shops || data.shops.length === 0) {
          shopsTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:20px;">No shops registered yet</td></tr>';
        } else {
          shopsTbody.innerHTML = data.shops.map(s => \`
            <tr>
              <td><strong>\${s.name}</strong></td>
              <td><code>\${s.slug}</code></td>
              <td>â‚¹\${s.bwPerPage} / page</td>
              <td>â‚¹\${s.colorPerPage} / page</td>
              <td>
                <span class="badge \${s.isAgentConnected ? 'badge-online' : 'badge-offline'}">
                  <span class="pulse"></span> \${s.isAgentConnected ? 'Station Live' : 'Station Offline'}
                </span>
              </td>
              <td>
                <a href="/shop/\${s.slug}" target="_blank" class="btn" style="padding:4px 8px; font-size:11px;">Open Print Page</a>
              </td>
            </tr>
          \`).join('');
        }

        // Render Jobs Table
        const jobsTbody = document.getElementById('jobsTableBody');
        if (!data.recentJobs || data.recentJobs.length === 0) {
          jobsTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:24px;">No print jobs yet</td></tr>';
        } else {
          jobsTbody.innerHTML = data.recentJobs.map(j => {
            const dateStr = new Date(j.updatedAt).toLocaleTimeString();
            const statusClass = 'st-' + j.status;
            let actionHtml = '-';
            if (j.status === 'MANUAL_REVIEW') {
              actionHtml = \`
                <button class="btn btn-requeue" onclick="resolveReview('\${j.jobId}', 'REQUEUE')">Requeue</button>
                <button class="btn btn-cancel" onclick="resolveReview('\${j.jobId}', 'CANCEL')">Cancel</button>
              \`;
            }
            return \`
              <tr>
                <td><code>\${j.jobId}</code></td>
                <td><code>\${j.orderId}</code></td>
                <td><span class="status-pill \${statusClass}">\${j.status}</span></td>
                <td>\${dateStr}</td>
                <td style="color:\${j.failureReason ? 'var(--yellow)' : 'var(--muted)'}; font-size:12px;">
                  \${j.failureReason || 'Normal processing'}
                </td>
                <td>\${actionHtml}</td>
              </tr>
            \`;
          }).join('');
        }
      } catch (err) {
        console.error('Error fetching summary:', err);
      }
    }

    async function resolveReview(jobId, action) {
      if (!confirm('Are you sure you want to ' + action + ' job ' + jobId + '?')) return;
      try {
        const res = await fetch('/api/admin/jobs/' + jobId + '/resolve-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, reason: 'Shopkeeper resolved via status dashboard' })
        });
        if (res.ok) {
          fetchSummary();
        } else {
          const err = await res.json();
          alert('Error: ' + (err.error || 'Failed to update job'));
        }
      } catch (err) {
        alert('Network error');
      }
    }

    function toggleAutoRefresh(enabled) {
      if (timer) clearInterval(timer);
      if (enabled) {
        timer = setInterval(fetchSummary, 5000);
      }
    }

    // Initial load
    loadShopQr();
    fetchSummary();
    timer = setInterval(fetchSummary, 5000);
  </script>
</body>
</html>`);
  });
};
