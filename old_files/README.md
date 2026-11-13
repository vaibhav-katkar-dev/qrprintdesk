# 🖨️ ShopPrint — Local Photocopy & Print Station

A zero-touch, zero-configuration local print server built for Xerox / photocopy shops. Customers scan a QR code at the counter on their phone, upload a PDF or image, and the shop's Windows PC prints it automatically (or after the shopkeeper approves).

- ⚡ **No internet needed** — operates 100% locally on your shop Wi-Fi / LAN (`shopprint.local`).
- 🔒 **Zero accounts or logins** — customers get a secure unguessable token and a 4-digit counter code (e.g., `#1042`).
- 📁 **Direct stream to disk** — files are never buffered into RAM; PDFs/photos are validated using worker threads.
- 🔄 **Autonomous FIFO Queue** — exactly 1 document printed at a time, crash recovery, and auto-pause on printer error.

---

## 🛠️ Stack

- **Node.js**: Node 20+ (supports Node 20, 22, and 24)
- **Framework**: Fastify, `@fastify/multipart` (streaming directly to disk), `@fastify/static`, `@fastify/cookie`
- **Database**: SQLite in WAL mode (native adaptive `better-sqlite3` and `node:sqlite`)
- **PDF Engine**: `pdf-lib` (magic byte checks, page counting, JPG/PNG to PDF conversion)
- **Frontend**: Alpine.js + HTML5 (bundled locally in `/public/vendor/alpine.min.js`, offline ready)
- **Printing**: Portable `SumatraPDF.exe` via CLI or built-in `MockPrinter`
- **Network**: Local IP auto-detection, dynamic QR generation, Bonjour mDNS (`shopprint.local`)
- **Logging**: Pino structured logging to file (`data/shopprint.log`) and console

---

## 🚀 Quick Start (Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Tests
Runs unit tests, crash recovery, queue ordering, magic byte validation, and 20 concurrent uploads:
```bash
npm test
```

### 3. Run Autocannon Load Test (30 concurrent uploads)
```bash
npm run loadtest
```

### 4. Start Server
```bash
# In mock printer mode (default, saves outputs to ./mock-output):
npm start

# With hot-reload during development:
npm run dev
```

Visit:
- **Customer Mobile Page**: `http://localhost:3000/` (or scan the QR)
- **Shopkeeper Console**: `http://localhost:3000/admin`

---

## 🪟 1-Click Windows Production Setup

### 🏁 For First-Time Setup & Daily Use:
There is **only ONE file** you need:
👉 **Double-click `ShopPrint.bat`**

1. **Auto-Configuration**: Verifies the portable runtime, creates a **Desktop Shortcut**, and opens the admin console.
2. **Auto-Recovery**: If power flickers or the server exits, it restarts automatically within 3 seconds.
3. **Hardware Ready**: Connects directly to your Windows default printer (Canon, HP, Epson, Brother).

---

### 📦 Deploying to Any Other Shop PC:
1. Run **`tools\PACK_PORTABLE_ZIP.bat`**.
2. Copy the resulting **`ShopPrint_Portable_Release.zip`** to a USB flash drive or cloud drive.
3. Extract it onto any other PC and double-click **`ShopPrint.bat`** — runs with zero installation required!

---

### 🔧 Maintenance Tools (`tools/` folder):
- `tools\TUNNEL_SETUP.bat` — Connect a custom company subdomain (e.g. `https://shop1.yourcompany.com`).
- `tools\INSTALL_TUNNEL_SERVICE.bat` — Run tunnel as a Windows Service (auto-starts on PC boot).
- `tools\RESET_PIN.bat` — Emergency reset of the shopkeeper master PIN.
- `tools\ALLOW_FIREWALL.bat` — Manually configure Windows Firewall rules if required.
- `tools\PACK_PORTABLE_ZIP.bat` — Generates a self-contained ZIP for other computers.

---

## 📱 User Workflow

### 1. Customer (`/`)
1. Customer connects to the shop's Wi-Fi and scans the printed QR code.
2. Selects a PDF, JPG, or PNG (up to 25 MB).
3. Selects number of copies (1-20), Black & White or Full Color, and Single or Double-sided.
4. Watches upload progress bar; receives a **4-digit Order Code** (e.g. `#4821`).
5. Live SSE tracking updates in real-time:
   ```
   Uploaded ➔ Waiting Approval ➔ In Queue (Position N) ➔ Printing ➔ Done!
   ```

### 2. Shopkeeper (`/admin`)
1. First run asks the shopkeeper to set a 4-8 digit master PIN.
2. Displays the customer QR code with current Wi-Fi IP and `shopprint.local` address.
3. **Auto-Print Toggle**:
   - `ON`: Documents enter queue and print automatically.
   - `OFF`: Each document rings an audio chime + visual flash; shopkeeper clicks **Approve** or **Reject**.
4. **Queue Control**: Pause / Resume, Cancel, Retry failed prints, or Reprint past jobs.
5. **Printer Selection**: Detects Windows printers automatically.
6. **Privacy Mode**: When enabled, original files are shredded immediately upon print completion.

---

## 🛡️ Reliability & Failure Handling

| Scenario | Behavior |
| :--- | :--- |
| **Printer Offline / Error** | Pauses the queue, marks job `FAILED`, sounds admin alert, auto-retries up to 2 times with backoff, then waits for shopkeeper to tap `Retry`. |
| **PC Crash / Restart** | On startup, jobs stuck in `PRINTING` are marked `CHECK_REPRINT` to prevent duplicate paper wastage; `QUEUED` jobs resume in FIFO order. |
| **Heavy Traffic (> 40 jobs)** | Returns HTTP 429 *"Shop is busy, try later"* to prevent overload. |
| **Low Disk Space (< 500 MB)** | Automatically blocks new uploads with friendly notice. |
| **Rate Limit** | Limits to 10 uploads per IP per 10 minutes to prevent abuse. |
| **Corrupt / Protected PDF** | Validated via magic bytes & worker threads. Rejects password-protected PDFs with *"Password-protected PDFs cannot be printed"*. |
| **File Retention** | Background hourly cleaner automatically removes files older than 24 hours. |

---

## 📂 Project Structure

```
├── bin/
│   └── SumatraPDF.exe          # Portable printer binary
├── data/
│   ├── shopprint.db            # SQLite WAL database
│   ├── shopprint.log           # Pino structured logs
│   └── uploads/                # Private streamed uploads
├── mock-output/                # Mock printed output files & metadata
├── public/
│   ├── index.html              # Customer mobile-first interface
│   ├── admin.html              # Shopkeeper dashboard
│   └── vendor/
│       └── alpine.min.js       # Offline bundled Alpine.js
├── src/
│   ├── config.js               # Central configuration
│   ├── db.js                   # SQLite schema & adaptive engine
│   ├── logger.js               # Pino logging setup
│   ├── network.js              # IP, printer detection & Bonjour mDNS
│   ├── fileProcessorWorker.js  # Worker thread for magic bytes & PDF
│   ├── printer.js              # SumatraPDF & Mock printer driver
│   ├── queue.js                # FIFO single-worker print queue
│   ├── cleanup.js              # 24-hour file cleanup scheduler
│   ├── routes/
│   │   ├── customer.js         # Upload & SSE status endpoints
│   │   └── admin.js            # PIN auth, settings & job controls
│   └── server.js               # Fastify server entrypoint
├── tests/
│   ├── shopprint.test.js       # Core logic & recovery unit tests
│   ├── api.test.js             # Concurrency & integration tests
│   └── load_test.js            # Autocannon 30-upload load test
├── Setup.ps1                   # Zero-touch Windows installer
└── package.json
```
