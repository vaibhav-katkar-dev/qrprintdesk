const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { PDFDocument } = require('pdf-lib');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');

let mainWindow = null;

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Paths & config
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const binDir = path.join(__dirname, '../bin');
const sumatraExe = path.join(binDir, 'SumatraPDF.exe');
const tmpDir = path.join(userDataPath, 'tmp');

if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// â”€â”€ Local Document Cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Downloads each job's files once and reuses them for repeat preview/prints.
// Cache dir lives in userData/doc-cache/ â€” survives app restarts.
// Max size: 500 MB. Files older than 7 days are auto-evicted on startup.
const docCacheDir = path.join(userDataPath, 'doc-cache');
if (!fs.existsSync(docCacheDir)) fs.mkdirSync(docCacheDir, { recursive: true });

const DOC_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const DOC_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Return the cached local path for a job file if it exists, otherwise null */
function getCachedFilePath(jobId, index) {
  // List files matching jobId_<index>.* pattern
  try {
    const files = fs.readdirSync(docCacheDir).filter(f => f.startsWith(`${jobId}_${index}.`));
    if (files.length > 0) {
      const full = path.join(docCacheDir, files[0]);
      if (fs.existsSync(full)) return full;
    }
  } catch (_) {}
  return null;
}

/** Download to doc-cache and return local path */
async function downloadToCache(url, jobId, index, ext) {
  const dest = path.join(docCacheDir, `${jobId}_${index}${ext}`);
  if (fs.existsSync(dest)) return dest; // already cached
  await downloadFile(url, dest);
  return dest;
}

/** Evict stale/oversized entries from doc-cache (runs once at startup) */
function evictDocCache() {
  try {
    const now = Date.now();
    let entries = fs.readdirSync(docCacheDir).map(f => {
      const fp = path.join(docCacheDir, f);
      try { const s = fs.statSync(fp); return { fp, size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
    }).filter(Boolean);

    // Remove files older than 7 days first
    for (const e of entries) {
      if (now - e.mtimeMs > DOC_CACHE_MAX_AGE_MS) {
        try { fs.unlinkSync(e.fp); } catch (_) {}
      }
    }

    // If still over limit, remove oldest first
    entries = fs.readdirSync(docCacheDir).map(f => {
      const fp = path.join(docCacheDir, f);
      try { const s = fs.statSync(fp); return { fp, size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalSize = entries.reduce((s, e) => s + e.size, 0);
    for (const e of entries) {
      if (totalSize <= DOC_CACHE_MAX_BYTES) break;
      try { fs.unlinkSync(e.fp); totalSize -= e.size; } catch (_) {}
    }
  } catch (err) {
    console.warn('Doc cache eviction error:', err.message);
  }
}

// Run eviction asynchronously at startup â€” no blocking
setImmediate(evictDocCache);

function loadConfig() {
  // If user config exists, load it
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      // Auto-migrate legacy root domain if it was set to qrprintdesk.in
      if (cfg.serverUrl === 'https://qrprintdesk.in' || cfg.serverUrl === 'http://qrprintdesk.in') {
        cfg.serverUrl = 'https://print.qrprintdesk.in';
        saveConfig(cfg);
      }
      return cfg;
    } catch (e) {
      console.error('Failed to parse user config:', e);
    }
  }

  // Default fallback for new installation
  return {
    serverUrl: 'https://print.qrprintdesk.in',
    agentToken: '',
    shopSlug: '',
    shopName: '',
    ownerEmail: '',
    autoPrint: true,
    soundAlert: true,
    autoEnhance: true,
    printerName: ''
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  return { success: true };
}

function createWindow() {
  const iconPath = path.join(__dirname, '../assets/icon.ico');

  mainWindow = new BrowserWindow({
    title: 'QrPrintDesk Vendor Station',
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#f4f7fb',
    frame: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Allow fetch to localhost without CORS/CSP restrictions
      webSecurity: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Allow window.open() for the poster print window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // If it's a blank window (poster print), allow it
    if (url === 'about:blank' || url.startsWith('blob:') || url === '') {
      return { action: 'allow' };
    }
    // External URLs â†’ open in browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Allow CSP for local and remote HTTPS/WSS (Cloudflare Tunnel)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:* https: wss: data: blob:"
        ]
      }
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Config
ipcMain.handle('get-config', async () => {
  return loadConfig();
});

ipcMain.handle('save-config', async (event, newConfig) => {
  return saveConfig(newConfig);
});

function ensureSumatraSettings() {
  const settingsContent = `# SumatraPDF Settings for QrPrintDesk Vendor Station\nCheckForUpdates = false\nMainWindowBackground = #ffffff\nPrinterDefaults [\n\tPrintScale = fit\n\tPrintAsImage = true\n]\n`;
  const targets = [
    path.join(binDir, 'SumatraPDF-settings.txt'),
    path.join(process.env.APPDATA || '', 'SumatraPDF', 'SumatraPDF-settings.txt'),
    path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF-settings.txt')
  ];
  for (const t of targets) {
    try {
      const pdir = path.dirname(t);
      if (!fs.existsSync(pdir)) fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(t, settingsContent, 'utf8');
    } catch (_) {}
  }
}

// IPC: Printers with live hardware status and spooler queue
ipcMain.handle('get-printers', async () => {
  if (!mainWindow) return [];
  try {
    const list = await mainWindow.webContents.getPrintersAsync();

    // Query Windows Print Spooler and Win32_Printer for accurate real-time hardware status
    return new Promise((resolve) => {
      const psScript = `
        $wmi = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue
        $gp = Get-Printer -ErrorAction SilentlyContinue
        $res = @()
        foreach ($p in $wmi) {
          $matchedGp = $gp | Where-Object { $_.Name -eq $p.Name }
          $qCount = if ($matchedGp) { [int]$matchedGp.JobCount } else { 0 }
          $isOff = [bool]($p.WorkOffline -or $p.PrinterStatus -eq 8)
          $res += [PSCustomObject]@{
            Name = $p.Name
            Offline = $isOff
            PortName = $p.PortName
            QueueCount = $qCount
            PrinterStatus = [int]$p.PrinterStatus
          }
        }
        $res | ConvertTo-Json -Compress
      `;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 6000 }, (err, stdout) => {
        let wmiMap = {};
        if (!err && stdout) {
          try {
            // Strip any PowerShell CLIXML header if present
            const cleanJson = stdout.replace(/#< CLIXML[\s\S]*?(?=\[|\{)/, '').replace(/<Objs[\s\S]*$/, '').trim();
            const parsed = JSON.parse(cleanJson);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            arr.forEach(p => {
              if (p && p.Name) {
                wmiMap[p.Name.toLowerCase()] = {
                  offline: !!p.Offline,
                  port: p.PortName || 'USB',
                  queueCount: p.QueueCount || 0
                };
              }
            });
          } catch (_) {}
        }

        const enriched = list.map(pr => {
          const info = wmiMap[pr.name.toLowerCase()] || {};
          let statusLabel = 'Ready';
          if (info.offline) {
            statusLabel = 'Offline';
          } else if (info.queueCount > 0) {
            statusLabel = `${info.queueCount} Job(s) In Queue`;
          }
          return {
            name: pr.name,
            displayName: pr.displayName || pr.name,
            isDefault: pr.isDefault,
            status: statusLabel,
            queueCount: info.queueCount || 0,
            port: info.port || 'USB'
          };
        });
        resolve(enriched);
      });
    });
  } catch (err) {
    console.error('Failed to get printers:', err);
    return [];
  }
});

// IPC: Flush Spooler - clears stuck print jobs safely across all queues and resets offline flags
ipcMain.handle('flush-spooler', async () => {
  return new Promise((resolve) => {
    const psScript = `
      $cleared = 0
      # 1. Clear jobs across all printers (iterates each printer cleanly without AmbiguousParameterSet)
      try {
        Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
          $pName = $_.Name
          Get-PrintJob -PrinterName $pName -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-PrintJob -PrinterName $pName -ID $_.Id -ErrorAction SilentlyContinue
            $cleared++
          }
        }
      } catch {}

      # Also fallback to Win32_PrintJob WMI if any remains
      try {
        Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-CimInstance -InputObject $_ -ErrorAction SilentlyContinue
          $cleared++
        }
      } catch {}

      # 2. Reset WorkOffline on any printer that got marked offline
      try {
        Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.WorkOffline -eq $true } | Set-CimInstance -Property @{ WorkOffline = $false } -ErrorAction SilentlyContinue
      } catch {}

      # 3. If running with admin privileges, also purge spool files and cycle service
      try {
        Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
        $spoolPath = "$env:SystemRoot\\System32\\spool\\PRINTERS\\*"
        Remove-Item -Path $spoolPath -Force -Recurse -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        Start-Service -Name Spooler -ErrorAction SilentlyContinue
      } catch {}

      Write-Output "SUCCESS: $cleared"
    `;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 10000 }, (error, stdout) => {
      const out = (stdout || '').trim();
      const match = out.match(/SUCCESS:\s*(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      resolve({
        success: true,
        clearedCount: count,
        message: count > 0 ? `Cleared ${count} stuck print job(s) from spooler.` : 'Spooler queue cleared and printer status reset.'
      });
    });
  });
});

// IPC: Query Windows Spooler Page Audit (Hardware audit to prevent paper theft / leak)
ipcMain.handle('get-spooler-audit', async () => {
  return new Promise((resolve) => {
    const psCmd = `Get-CimInstance -ClassName Win32_PrintJob -ErrorAction SilentlyContinue | Select-Object JobId,Document,TotalPages,PagesPrinted,DriverName,JobStatus | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 10000 }, (error, stdout) => {
      if (error || !stdout || !stdout.trim()) {
        return resolve({ success: true, jobs: [] });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const jobs = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        resolve({ success: true, jobs });
      } catch (_) {
        resolve({ success: true, jobs: [] });
      }
    });
  });
});

// IPC: Open External URL
ipcMain.handle('open-external', async (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// Ephemeral OAuth loopback server for Google Desktop Authentication
let oauthServer = null;

ipcMain.handle('start-google-auth', async (event, serverBaseUrl) => {
  return new Promise((resolve) => {
    try {
      if (oauthServer) {
        try { oauthServer.close(); } catch (_) {}
        oauthServer = null;
      }

      oauthServer = http.createServer((req, res) => {
        // Handle CORS preflight
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url.startsWith('/callback')) {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', message: 'Station Connected! Return to Desktop App.' }));

            let authData = null;
            try {
              if (body) {
                authData = JSON.parse(body);
              } else {
                const u = new URL(req.url, 'http://127.0.0.1');
                const token = u.searchParams.get('token');
                if (token) authData = { agentToken: token };
              }
            } catch (err) {
              console.error('Failed to parse OAuth callback body:', err);
            }

            if (oauthServer) {
              try { oauthServer.close(); } catch (_) {}
              oauthServer = null;
            }

            if (authData) {
              resolve({ success: true, authData });
            } else {
              resolve({ success: false, error: 'Empty auth payload' });
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      // Listen on random free port
      oauthServer.listen(0, '127.0.0.1', () => {
        const port = oauthServer.address().port;
        const targetUrl = `${(serverBaseUrl || 'https://print.qrprintdesk.in').replace(/\/+$/, '')}/vendor?desktop_login=${port}`;
        shell.openExternal(targetUrl);
      });

      // Timeout after 120 seconds
      setTimeout(() => {
        if (oauthServer) {
          try { oauthServer.close(); } catch (_) {}
          oauthServer = null;
          resolve({ success: false, error: 'Google sign-in timed out. Please try again.' });
        }
      }, 120000);

    } catch (err) {
      if (oauthServer) {
        try { oauthServer.close(); } catch (_) {}
        oauthServer = null;
      }
      resolve({ success: false, error: err.message });
    }
  });
});

ipcMain.handle('cancel-google-auth', async () => {
  if (oauthServer) {
    try { oauthServer.close(); } catch (_) {}
    oauthServer = null;
  }
  return { success: true };
});

// IPC: Window controls
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// Helper: Download file with redirect following
function downloadFile(url, dest, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => {
          downloadFile(response.headers.location, dest, maxRedirects - 1).then(resolve).catch(reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        file.close(() => {
          fs.unlink(dest, () => {});
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        });
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(dest));
      });
    }).on('error', (err) => {
      file.close(() => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
  });
}

// Auto-Enhancement for images using Windows GDI+ / PowerShell (sharp text, deep black, pure white paper)
function enhanceImage(inputPath, outputPath, colorMode) {
  return new Promise((resolve) => {
    const escapedInput = inputPath.replace(/'/g, "''");
    const escapedOutput = outputPath.replace(/'/g, "''");
    const isMono = (colorMode === 'monochrome' || colorMode === 'bw');
    const psScript = `
      Add-Type -AssemblyName System.Drawing
      $img = $null; $canvas = $null; $g = $null; $ms = $null
      try {
        $bytes = [System.IO.File]::ReadAllBytes('${escapedInput}')
        $ms = New-Object System.IO.MemoryStream(,$bytes)
        $img = [System.Drawing.Image]::FromStream($ms)

        # 1. EXIF Auto-Orientation
        try {
          $prop = $img.GetPropertyItem(0x0112)
          if ($prop) {
            $val = [System.BitConverter]::ToUInt16($prop.Value, 0)
            if ($val -eq 3) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
            elseif ($val -eq 6) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
            elseif ($val -eq 8) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
          }
        } catch {}

        # 2. Bound maximum dimension to 2400px (clean 300 DPI, eliminates memory buffer overflow)
        $maxDim = 2400
        $w = $img.Width; $h = $img.Height
        if ($w -gt $maxDim -or $h -gt $maxDim) {
          $scale = [Math]::Min([double]$maxDim / $w, [double]$maxDim / $h)
          $w = [int]($w * $scale)
          $h = [int]($h * $scale)
        }

        # 3. Canvas Setup at natural aspect ratio
        $canvas = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $canvas.SetResolution(300, 300)
        $g = [System.Drawing.Graphics]::FromImage($canvas)
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

        # 4. Color / Photocopy Enhancement Matrix
        $ia = New-Object System.Drawing.Imaging.ImageAttributes
        if (${isMono ? '$true' : '$false'}) {
          # Deep black text, clean white paper, no grey washed-out look
          $c = 1.45; $b = -0.05
          $r = 0.299 * $c; $gw = 0.587 * $c; $bl = 0.114 * $c
          $matrix = New-Object 'Single[][]' 5,5
          $matrix[0] = [Single[]]@($r,   $r,   $r,   0, 0)
          $matrix[1] = [Single[]]@($gw,  $gw,  $gw,  0, 0)
          $matrix[2] = [Single[]]@($bl,  $bl,  $bl,  0, 0)
          $matrix[3] = [Single[]]@(0,    0,    0,    1, 0)
          $matrix[4] = [Single[]]@($b,   $b,   $b,   0, 1)
          $cm = New-Object System.Drawing.Imaging.ColorMatrix(,$matrix)
          $ia.SetColorMatrix($cm, [System.Drawing.Imaging.ColorMatrixFlag]::Default, [System.Drawing.Imaging.ColorAdjustType]::Bitmap)
        } else {
          # Vibrant color without washout
          $c = 1.10; $b = 0.00
          $matrix = New-Object 'Single[][]' 5,5
          $matrix[0] = [Single[]]@($c, 0,  0,  0, 0)
          $matrix[1] = [Single[]]@(0,  $c, 0,  0, 0)
          $matrix[2] = [Single[]]@(0,  0,  $c, 0, 0)
          $matrix[3] = [Single[]]@(0,  0,  0,  1, 0)
          $matrix[4] = [Single[]]@($b, $b, $b, 0, 1)
          $cm = New-Object System.Drawing.Imaging.ColorMatrix(,$matrix)
          $ia.SetColorMatrix($cm, [System.Drawing.Imaging.ColorMatrixFlag]::Default, [System.Drawing.Imaging.ColorAdjustType]::Bitmap)
        }

        # 5. Draw Image to Canvas
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
        $g.DrawImage($img, $destRect, 0, 0, $img.Width, $img.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)

        # 6. Save as High-Quality JPEG
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]95)
        $canvas.Save('${escapedOutput}', $codec, $encParams)
        Write-Output 'OK'
      } catch {
        Write-Output "ERR: $_"
      } finally {
        if ($g)      { try { $g.Dispose() } catch {} }
        if ($canvas) { try { $canvas.Dispose() } catch {} }
        if ($img)    { try { $img.Dispose() } catch {} }
        if ($ms)     { try { $ms.Dispose() } catch {} }
      }
    `;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30000 }, (error, stdout) => {
      if (!error && stdout && stdout.includes('OK') && fs.existsSync(outputPath)) {
        resolve(true);
      } else {
        console.error('Enhance failed:', stdout, error);
        resolve(false);
      }
    });
  });
}

// Assemble clean, standardized composite PDF (handles 2-on-1 Eco layout, multiple images, and PDF pages)
async function createJobPrintablePdf(jobId, localFiles, printOptions) {
  const is2on1 = Number(printOptions?.pagesPerSheet) === 2;
  const isLandscape = printOptions?.orientation === 'landscape';
  const isStampPaper = Boolean(printOptions?.stampPaperMode);

  // Standard A4 dimensions in PDF points (72 points/inch)
  const A4_W = isLandscape ? 841.89 : 595.28;
  const A4_H = isLandscape ? 595.28 : 841.89;

  // If only 1 PDF file with 1-on-1 layout and NOT Stamp Paper mode, use direct file
  if (!is2on1 && !isStampPaper && localFiles.length === 1 && path.extname(localFiles[0]).toLowerCase() === '.pdf') {
    return localFiles[0];
  }

  const pdfDoc = await PDFDocument.create();

  // Helper to draw an item (image or embedded PDF page) in a bounding box with aspect ratio preserved
  function drawInBox(page, item, bx, by, bw, bh) {
    const scale = Math.min(bw / item.width, bh / item.height);
    const dw = item.width * scale;
    const dh = item.height * scale;
    const dx = bx + (bw - dw) / 2;
    const dy = by + (bh - dh) / 2;
    if (item.type === 'image') {
      page.drawImage(item.img, { x: dx, y: dy, width: dw, height: dh });
    } else {
      page.drawPage(item.ep, { x: dx, y: dy, width: dw, height: dh });
    }
  }

  // Collect all drawable items across all files in order
  const items = [];
  for (const f of localFiles) {
    const ext = path.extname(f).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.bmp', '.jfif', '.webp'].includes(ext)) {
      const bytes = fs.readFileSync(f);
      let img;
      try {
        img = (ext === '.png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      } catch (embedErr) {
        img = await pdfDoc.embedJpg(bytes);
      }
      items.push({ type: 'image', img, width: img.width, height: img.height });
    } else if (ext === '.pdf') {
      const bytes = fs.readFileSync(f);
      const srcPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pageIndices = srcPdf.getPageIndices();
      const embeddedPages = await pdfDoc.embedPdf(srcPdf, pageIndices);
      for (const ep of embeddedPages) {
        items.push({ type: 'pdfPage', ep, width: ep.width, height: ep.height });
      }
    }
  }

  if (items.length === 0) {
    throw new Error('No printable images or PDF pages found in job.');
  }

  if (is2on1) {
    // 2-on-1: Exactly two items per sheet to eliminate paper wastage
    const margin = 20;
    if (isLandscape) {
      // Landscape: 2 columns side by side
      const slotW = (A4_W - (margin * 3)) / 2;
      const slotH = A4_H - (margin * 2);
      for (let i = 0; i < items.length; i += 2) {
        const page = pdfDoc.addPage([A4_W, A4_H]);
        drawInBox(page, items[i], margin, margin, slotW, slotH);
        if (i + 1 < items.length) {
          drawInBox(page, items[i + 1], margin * 2 + slotW, margin, slotW, slotH);
        }
      }
    } else {
      // Portrait: 2 rows top and bottom (ideal for Aadhaar/ID front & back or documents)
      const slotW = A4_W - (margin * 2);
      const slotH = (A4_H - (margin * 3)) / 2;
      for (let i = 0; i < items.length; i += 2) {
        const page = pdfDoc.addPage([A4_W, A4_H]);
        // Top slot (PDF coordinates measure Y from bottom)
        const topSlotY = margin * 2 + slotH;
        drawInBox(page, items[i], margin, topSlotY, slotW, slotH);
        if (i + 1 < items.length) {
          drawInBox(page, items[i + 1], margin, margin, slotW, slotH);
        }
      }
    }
  } else {
    // 1-on-1: One item per sheet with clean, safe margins (handles Indian Legal Stamp Paper top clearance)
    const margin = 20;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const page = pdfDoc.addPage([A4_W, A4_H]);
      if (isStampPaper && i === 0) {
        // Stamp Paper Mode: Leave 3.5 inches (252 points) top margin clear for government seal & revenue stamp
        const topStampClearance = 252;
        const boxW = A4_W - (margin * 2);
        const boxH = A4_H - topStampClearance - margin;
        drawInBox(page, item, margin, margin, boxW, boxH);
      } else {
        const boxW = A4_W - (margin * 2);
        const boxH = A4_H - (margin * 2);
        drawInBox(page, item, margin, margin, boxW, boxH);
      }
    }
  }

  const outBytes = await pdfDoc.save();
  const outPath = path.join(tmpDir, `job_${jobId}_composite.pdf`);
  fs.writeFileSync(outPath, outBytes);
  return outPath;
}

// Spool PDF to printer via SumatraPDF (single reliable print job, zero buffer crashes)
function spoolPrint(filePath, printOptions, printerName) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sumatraExe)) {
      console.error('SumatraPDF not found at:', sumatraExe);
      return resolve(false);
    }

    ensureSumatraSettings();

    const copies = (printOptions && printOptions.copies > 1) ? printOptions.copies : 1;
    const paper = (printOptions && printOptions.paperSize) ? printOptions.paperSize : 'A4';
    const parts = [];

    // 1. Page range if specified by customer
    if (printOptions && printOptions.pageRange && printOptions.pageRange.trim()) {
      parts.push(printOptions.pageRange.trim());
    }

    // 2. Fit to printable area
    parts.push('fit');

    // 3. Paper size
    parts.push(`paper=${paper}`);

    // 4. Orientation
    if (printOptions && printOptions.orientation === 'landscape') parts.push('landscape');
    else if (printOptions && printOptions.orientation === 'portrait') parts.push('portrait');

    // 5. Duplex
    if (printOptions && printOptions.duplexMode === 'duplexlong') parts.push('duplex');
    else if (printOptions && printOptions.duplexMode === 'duplexshort') parts.push('duplexshort');

    // 6. Copies (SumatraPDF syntax: Nx e.g. 2x)
    if (copies > 1) parts.push(`${copies}x`);

    const settings = parts.join(',');
    const args = ['-print-settings', settings, '-silent', '-exit-when-done'];
    if (printerName) {
      args.push('-print-to', printerName);
    } else {
      args.push('-print-to-default');
    }
    args.push(filePath);

    console.log('Spooling via SumatraPDF:', sumatraExe, args.join(' '));
    execFile(sumatraExe, args, { timeout: 60000 }, (err) => {
      if (err) {
        console.error('Spool print error:', err);
        resolve(false);
      } else {
        console.log('SumatraPDF print completed successfully');
        resolve(true);
      }
    });
  });
}

// IPC: Print Job (Automated composite generation, zero extra print wastage, single spool)
ipcMain.handle('print-job', async (event, jobData) => {
  const cfg = loadConfig();
  const { jobId, downloadUrls, printOptions } = jobData;

  try {
    const downloadedFiles = [];
    const tempEnhancedFiles = [];

    // 1. Download all job files into local cache
    for (let i = 0; i < downloadUrls.length; i++) {
      const { url, filename } = downloadUrls[i];
      const ext = path.extname(filename || '') || '.pdf';
      const cachedFile = await downloadToCache(url, jobId, i, ext);

      const isImage = /\.(jpe?g|png|bmp|jfif|webp|tiff?)$/i.test(ext);
      if (isImage && cfg.autoEnhance) {
        const enhancedTmp = path.join(tmpDir, `enhanced_${jobId}_${i}.jpg`);
        const colorMode = (printOptions && printOptions.colorMode) || 'monochrome';
        const ok = await enhanceImage(cachedFile, enhancedTmp, colorMode);
        if (ok && fs.existsSync(enhancedTmp)) {
          downloadedFiles.push(enhancedTmp);
          tempEnhancedFiles.push(enhancedTmp);
          continue;
        }
      }
      downloadedFiles.push(cachedFile);
    }

    // 2. Build clean composite PDF (handles 2-on-1 layout, multi-image merging, A4 margins)
    let compositePdf = null;
    let printTarget = downloadedFiles[0];

    try {
      compositePdf = await createJobPrintablePdf(jobId, downloadedFiles, printOptions);
      printTarget = compositePdf;
    } catch (composeErr) {
      console.warn('PDF composite fallback, using first file:', composeErr);
      printTarget = downloadedFiles[0];
    }

    // 3. Spool to printer via SumatraPDF ONCE (prevents duplicate printing and Canon driver crashes)
    const printer = cfg.printerName || '';
    const printed = await spoolPrint(printTarget, printOptions, printer);

    // 4. Cleanup temporary composite and enhanced copies
    if (compositePdf && compositePdf !== downloadedFiles[0]) {
      try { fs.unlinkSync(compositePdf); } catch {}
    }
    for (const ef of tempEnhancedFiles) {
      try { fs.unlinkSync(ef); } catch {}
    }

    // 5. Report status to server
    const outcome = printed ? 'SUCCESS' : 'UNCERTAIN';
    const reportUrl = `${cfg.serverUrl}/api/agent/jobs/${jobId}/status`;
    try {
      const resp = await fetch(reportUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.agentToken}`
        },
        body: JSON.stringify({ outcome, opId: Math.random().toString(36).substring(2) })
      });
      const data = await resp.json().catch(() => ({}));
      console.log(`Reported job #${jobId} outcome ${outcome} -> HTTP ${resp.status}`, data);
    } catch (reportErr) {
      console.error('Failed to report job status to server:', reportErr);
    }

    return { success: printed, outcome };
  } catch (err) {
    console.error('Job execution failed:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Preview Job (Uses local document cache â€” 0ms lag on re-opens)
ipcMain.handle('preview-job', async (event, data) => {
  try {
    const fileUrl = typeof data === 'string' ? data : data?.fileUrl;
    const filename = typeof data === 'object' ? data?.filename : '';
    const jobId = typeof data === 'object' ? data?.jobId : null;
    const index = typeof data === 'object' && data?.index !== undefined ? data.index : 0;

    let ext = (filename && path.extname(filename)) || '';
    if (!ext && fileUrl) {
      try {
        const u = new URL(fileUrl);
        ext = path.extname(u.pathname);
      } catch {}
    }
    if (!ext) ext = '.pdf';

    // Check persistent cache first; download only if not cached yet
    let targetPath;
    if (jobId) {
      targetPath = await downloadToCache(fileUrl, jobId, index, ext);
    } else {
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5').update(fileUrl || filename || Date.now().toString()).digest('hex').substring(0, 12);
      targetPath = await downloadToCache(fileUrl, `pv_${hash}`, 0, ext);
    }

    const openErr = await shell.openPath(targetPath);
    if (openErr) {
      console.warn('shell.openPath failed, opening with SumatraPDF:', openErr);
      if (fs.existsSync(sumatraExe)) {
        execFile(sumatraExe, [targetPath], () => {});
      } else {
        return { success: false, error: openErr };
      }
    }
    return { success: true };
  } catch (err) {
    console.error('Preview error:', err);
    return { success: false, error: err.message };
  }
});
