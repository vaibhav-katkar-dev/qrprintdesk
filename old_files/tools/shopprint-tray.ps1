# ============================================================
#  ShopPrint Station Application (shopprint-tray.ps1)
#  - Runs Node server hidden in background (0 terminal windows)
#  - Modern floating desktop quick-access widget ("Pet / Dock")
#  - System tray icon with live status & controls
#  - Instant 1-click expand to full Admin Console
#  - Error handling with native Windows GUI popups
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Win32 helper to focus, restore, and drag windows
$cSharpCode = @"
using System;
using System.Runtime.InteropServices;
public class WinHelper {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
    public const int SW_RESTORE = 9;
    public const int SW_SHOW    = 5;
    public const int WM_NCLBUTTONDOWN = 0xA1;
    public const int HT_CAPTION = 0x2;
}
"@
Add-Type -TypeDefinition $cSharpCode -ErrorAction SilentlyContinue

function Show-GuiError([string]$title, [string]$message) {
    [System.Windows.Forms.MessageBox]::Show(
        $message,
        $title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

try {
    $CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    if ((Split-Path -Leaf $CurrentDir) -eq "tools") {
        $ScriptDir = Split-Path -Parent $CurrentDir
    } else {
        $ScriptDir = $CurrentDir
    }
    if (-not $ScriptDir -or -not (Test-Path "$ScriptDir\src\server.js")) {
        if (Test-Path "C:\ShopPrint\src\server.js") { $ScriptDir = "C:\ShopPrint" }
        elseif (Test-Path "H:\Print\src\server.js") { $ScriptDir = "H:\Print" }
    }

    function Log-Debug([string]$msg) {
        try {
            $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
            Add-Content -Path "$ScriptDir\tray.log" -Value "[$ts] $msg" -ErrorAction SilentlyContinue
        } catch {}
    }
    Log-Debug "=== ShopPrint Tray Starting (ScriptDir=$ScriptDir) ==="
    function Get-AppBrowser {
        $x86 = [System.Environment]::GetFolderPath('ProgramFilesX86')
        $x64 = [System.Environment]::GetFolderPath('ProgramFiles')
        $list = @(
            (Join-Path $x86 "Microsoft\Edge\Application\msedge.exe"),
            (Join-Path $x64 "Microsoft\Edge\Application\msedge.exe"),
            (Join-Path $x64 "Google\Chrome\Application\chrome.exe"),
            (Join-Path $x86 "Google\Chrome\Application\chrome.exe")
        )
        foreach ($b in $list) {
            if ($b -and (Test-Path $b)) { return $b }
        }
        return $null
    }

    $browserExe = Get-AppBrowser
    $adminUrl   = "http://localhost:3000/admin"

    function Open-AdminWindow {
        $found = $false
        $allBrowsers = Get-Process "msedge","chrome" -ErrorAction SilentlyContinue
        foreach ($p in $allBrowsers) {
            if ($p.MainWindowTitle -match "ShopPrint" -and $p.MainWindowHandle -ne 0) {
                if ([WinHelper]::IsIconic($p.MainWindowHandle)) {
                    [WinHelper]::ShowWindow($p.MainWindowHandle, [WinHelper]::SW_RESTORE) | Out-Null
                }
                [WinHelper]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
                $found = $true
                break
            }
        }

        if (-not $found) {
            if ($browserExe) {
                Start-Process -FilePath $browserExe -ArgumentList @(
                    "--new-window",
                    "--app=$adminUrl",
                    "--window-size=1380,870",
                    "--window-position=30,20",
                    "--no-first-run",
                    "--disable-extensions"
                ) -ErrorAction SilentlyContinue
            } else {
                Start-Process $adminUrl
            }
        }
    }

    # --- 2. Single-instance lock ---
    $mutexName = "ShopPrintStation_SingleInstance"
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    if (-not $mutex.WaitOne(0, $false)) {
        Log-Debug "Another instance already holds mutex $mutexName. Activating window and exiting."
        Open-AdminWindow
        exit 0
    }
    Log-Debug "Mutex acquired successfully ($mutexName)."

    # --- 3. Kill any stuck orphan process on port 3000 ---
    try {
        $listening = netstat -ano | Select-String "LISTENING" | Select-String ":3000\s"
        foreach ($line in $listening) {
            if ($line -match '\s+(\d+)\s*$') {
                $pidToKill = [int]$Matches[1]
                if ($pidToKill -gt 4) {
                    Log-Debug "Killing process $pidToKill listening on port 3000"
                    Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}

    # --- 4. Ensure directories exist ---
    @("$ScriptDir\bin", "$ScriptDir\data", "$ScriptDir\data\uploads", "$ScriptDir\temp") | ForEach-Object {
        if (-not (Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
    }

    # --- 5. Locate Node.js runtime ---
    $nodeBin = $null
    if (Test-Path "$ScriptDir\bin\node.exe") {
        $nodeBin = "$ScriptDir\bin\node.exe"
    } else {
        try { $nodeBin = (Get-Command node -ErrorAction Stop).Source } catch {}
    }
    Log-Debug "Node binary: $nodeBin"

    if (-not $nodeBin) {
        Log-Debug "ERROR: Node binary not found!"
        Show-GuiError "ShopPrint - Missing Runtime" "Node.js engine was not found on your system.`n`nPlease install Node.js from https://nodejs.org or run ShopPrint_Setup.exe."
        $mutex.ReleaseMutex()
        exit 1
    }

    # --- 6. Verify SumatraPDF portable ---
    if (-not (Test-Path "$ScriptDir\bin\SumatraPDF.exe")) {
        try {
            $zip = "$ScriptDir\bin\sumatra.zip"
            Invoke-WebRequest 'https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
            Expand-Archive $zip -DestinationPath "$ScriptDir\bin" -Force
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            $v = "$ScriptDir\bin\SumatraPDF-3.6.1-64.exe"
            if (Test-Path $v) { Copy-Item $v "$ScriptDir\bin\SumatraPDF.exe" -Force }
        } catch {}
    }

    # --- 7. Load Tray Icon ---
    $trayIconObj = $null
    $icoPath = "$ScriptDir\app.ico"
    if (-not (Test-Path $icoPath)) { $icoPath = "$ScriptDir\public\app.ico" }
    if (Test-Path $icoPath) {
        try {
            $trayIconObj = New-Object System.Drawing.Icon($icoPath)
        } catch {}
    }
    if (-not $trayIconObj) {
        try {
            $bmp = New-Object System.Drawing.Bitmap(32, 32)
            $g   = [System.Drawing.Graphics]::FromImage($bmp)
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 0, 0, 32, 32)
            $g.FillRectangle([System.Drawing.Brushes]::White,     6, 11, 20, 12)
            $g.FillRectangle([System.Drawing.Brushes]::White,     9,  6, 14,  6)
            $g.FillRectangle([System.Drawing.Brushes]::LightCyan, 9, 19, 14,  7)
            $g.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 18, 13, 4,  3)
            $g.Dispose()
            $trayIconObj = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
        } catch {
            $trayIconObj = [System.Drawing.SystemIcons]::Application
        }
    }

    # Ensure Windows taskbar shows tray icons directly without hiding in overflow ^
    try {
        Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer" -Name "EnableAutoTray" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    } catch {}

    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon    = $trayIconObj
    $tray.Text    = "ShopPrint - Starting..."
    $tray.Visible = $true

    # --- 8. Launch Node server in background ---
    $env:PRINTER_MODE = "real"
    $serverJs = "$ScriptDir\src\server.js"
    function Start-NodeServer {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName         = $nodeBin
        $psi.Arguments        = "`"$serverJs`""
        $psi.WorkingDirectory = $ScriptDir
        $psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.UseShellExecute  = $true
        return [System.Diagnostics.Process]::Start($psi)
    }

    $script:nodeProc = Start-NodeServer

    # --- 9. Launch Cloudflare Tunnel if configured ---
    $script:cfProc      = $null
    $script:cfToken     = ""
    $script:cfExePath   = ""
    $tunnelToken = "$ScriptDir\bin\tunnel_token.txt"
    if ((Test-Path $tunnelToken) -and (Test-Path "$ScriptDir\bin\cloudflared.exe")) {
        $script:cfToken   = (Get-Content $tunnelToken -Raw).Trim()
        $script:cfExePath = "$ScriptDir\bin\cloudflared.exe"
        if ($script:cfToken) {
            $psi2 = New-Object System.Diagnostics.ProcessStartInfo
            $psi2.FileName         = $script:cfExePath
            $psi2.Arguments        = "tunnel --protocol http2 run --token `"$($script:cfToken)`""
            $psi2.WorkingDirectory = $ScriptDir
            $psi2.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
            $psi2.CreateNoWindow   = $true
            $psi2.UseShellExecute  = $false
            $script:cfProc = [System.Diagnostics.Process]::Start($psi2)
            Log-Debug "cloudflared started PID: $($script:cfProc.Id)"
        }
    } else {
        Log-Debug "cloudflared not configured (token or binary missing)"
    }

    # ============================================================
    #  --- 10. FLOATING DESKTOP QUICK-ACCESS WIDGET ("Pet / Dock") ---
    # ============================================================
    $widget = New-Object System.Windows.Forms.Form
    $widget.Text            = "ShopPrint Assistant"
    $widget.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $widget.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual
    $widget.Size            = New-Object System.Drawing.Size(280, 72)
    $widget.BackColor       = [System.Drawing.Color]::FromArgb(15, 23, 42) # Slate 900
    $widget.TopMost         = $true
    $widget.ShowInTaskbar   = $false

    # Initial position: bottom right corner, above taskbar
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $widget.Location = New-Object System.Drawing.Point(($screen.Right - 300), ($screen.Bottom - 95))

    # Inner Border Panel (for clean background & border rendering)
    $pnlMain = New-Object System.Windows.Forms.Panel
    $pnlMain.Size     = New-Object System.Drawing.Size(276, 68)
    $pnlMain.Location = New-Object System.Drawing.Point(2, 2)
    $pnlMain.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $widget.Controls.Add($pnlMain)

    # Mascot / App Icon PictureBox
    $pbIcon = New-Object System.Windows.Forms.PictureBox
    $pbIcon.Size     = New-Object System.Drawing.Size(36, 36)
    $pbIcon.Location = New-Object System.Drawing.Point(10, 16)
    $pbIcon.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage
    $pbIcon.Cursor   = [System.Windows.Forms.Cursors]::Hand

    if (Test-Path $icoPath) {
        try {
            $pbIcon.Image = [System.Drawing.Image]::FromFile($icoPath)
        } catch {}
    }
    $pnlMain.Controls.Add($pbIcon)

    # Title label: "SHOPPRINT ASSISTANT"
    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text      = "SHOPPRINT ASSISTANT"
    $lblTitle.Font      = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Bold)
    $lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184) # Slate 400
    $lblTitle.Location  = New-Object System.Drawing.Point(52, 10)
    $lblTitle.AutoSize  = $true
    $pnlMain.Controls.Add($lblTitle)

    # Status label: "[o] Ready for prints"
    $lblStatus = New-Object System.Windows.Forms.Label
    $lblStatus.Text      = "[o] Ready for prints"
    $lblStatus.Font      = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(16, 185, 129) # Emerald Green
    $lblStatus.Location  = New-Object System.Drawing.Point(52, 28)
    $lblStatus.AutoSize  = $true
    $lblStatus.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $pnlMain.Controls.Add($lblStatus)

    # Hint label: "Click to open Admin Console"
    $lblHint = New-Object System.Windows.Forms.Label
    $lblHint.Text      = "Click to open Admin Console"
    $lblHint.Font      = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Regular)
    $lblHint.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139) # Slate 500
    $lblHint.Location  = New-Object System.Drawing.Point(52, 48)
    $lblHint.AutoSize  = $true
    $lblHint.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $pnlMain.Controls.Add($lblHint)

    # Minimize button: "_"
    $btnMin = New-Object System.Windows.Forms.Label
    $btnMin.Text      = "_"
    $btnMin.Font      = New-Object System.Drawing.Font("Segoe UI", 8.0, [System.Drawing.FontStyle]::Bold)
    $btnMin.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $btnMin.Location  = New-Object System.Drawing.Point(254, 4)
    $btnMin.Size      = New-Object System.Drawing.Size(18, 18)
    $btnMin.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $btnMin.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $btnMin.add_Click({
        $widget.Hide()
        $tray.BalloonTipTitle = "ShopPrint Minimized"
        $tray.BalloonTipText  = "Assistant hidden to tray. Click the printer tray icon anytime to reopen."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
        $tray.ShowBalloonTip(2000)
    })
    $pnlMain.Controls.Add($btnMin)

    # Form outer border drawing (sharp modern accent border)
    $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(59, 130, 246)
    $widget.add_Paint({
        param($s, $e)
        $pen = New-Object System.Drawing.Pen($script:widgetBorderColor, 2)
        $e.Graphics.DrawRectangle($pen, 0, 0, 279, 71)
        $pen.Dispose()
    })

    # Drag handler: Dragging anywhere on title, panel, or icon moves the widget
    $dragHandler = {
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            [WinHelper]::ReleaseCapture()
            [WinHelper]::SendMessage($widget.Handle, [WinHelper]::WM_NCLBUTTONDOWN, [WinHelper]::HT_CAPTION, 0)
        }
    }
    $pnlMain.add_MouseDown($dragHandler)
    $lblTitle.add_MouseDown($dragHandler)
    $pbIcon.add_MouseDown($dragHandler)

    # Click handler: Clicking status or hint immediately opens Admin Console
    $lblStatus.add_Click({ Open-AdminWindow })
    $lblHint.add_Click({ Open-AdminWindow })
    $pbIcon.add_DoubleClick({ Open-AdminWindow })
    $pnlMain.add_DoubleClick({ Open-AdminWindow })

    # --- 11. Context Menus ---
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
    $miOpen.Text = "Open Admin Console"
    $miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
    $miOpen.add_Click({ Open-AdminWindow })

    $miCustomer = New-Object System.Windows.Forms.ToolStripMenuItem
    $miCustomer.Text = "Open Customer QR Page"
    $miCustomer.add_Click({
        if ($browserExe) {
            Start-Process $browserExe "--app=http://localhost:3000 --no-first-run" -ErrorAction SilentlyContinue
        } else {
            Start-Process "http://localhost:3000"
        }
    })

    $miShowWidget = New-Object System.Windows.Forms.ToolStripMenuItem
    $miShowWidget.Text = "Show Floating Assistant"
    $miShowWidget.add_Click({
        $widget.Show()
        [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
        $widget.BringToFront()
    })

    $miHideWidget = New-Object System.Windows.Forms.ToolStripMenuItem
    $miHideWidget.Text = "Hide Floating Bar (Keep in Tray)"
    $miHideWidget.add_Click({
        $widget.Hide()
    })

    $miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
    $miStatus.Text    = "Status: Checking..."
    $miStatus.Enabled = $false

    $miSep1 = New-Object System.Windows.Forms.ToolStripSeparator

    # Startup auto-run registry key
    $regPath  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $regName  = "ShopPrint"
    $regValue = "wscript.exe `"$ScriptDir\ShopPrint.vbs`""

    $miStartup = New-Object System.Windows.Forms.ToolStripMenuItem
    $miStartup.Text    = "Start Automatically with Windows"
    $isReg = (Get-ItemProperty -Path $regPath -Name $regName -ErrorAction SilentlyContinue).$regName
    $miStartup.Checked = ($null -ne $isReg -and $isReg -ne "")

    $miStartup.add_Click({
        $cur = (Get-ItemProperty -Path $regPath -Name $regName -ErrorAction SilentlyContinue).$regName
        if ($cur) {
            Remove-ItemProperty -Path $regPath -Name $regName -ErrorAction SilentlyContinue
            $miStartup.Checked = $false
            $tray.BalloonTipTitle = "Auto-start Disabled"
            $tray.BalloonTipText  = "ShopPrint will not start automatically with Windows."
            $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
            $tray.ShowBalloonTip(2500)
        } else {
            Set-ItemProperty -Path $regPath -Name $regName -Value $regValue
            $miStartup.Checked = $true
            $tray.BalloonTipTitle = "Auto-start Enabled"
            $tray.BalloonTipText  = "ShopPrint will start automatically whenever your PC boots."
            $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
            $tray.ShowBalloonTip(2500)
        }
    })

    $miSep2 = New-Object System.Windows.Forms.ToolStripSeparator

    $miExit = New-Object System.Windows.Forms.ToolStripMenuItem
    $miExit.Text = "Exit ShopPrint"
    $miExit.add_Click({
        $ans = [System.Windows.Forms.MessageBox]::Show(
            "Exit ShopPrint Station?`n`nCustomers will not be able to send print jobs until you restart ShopPrint.",
            "Exit ShopPrint",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) {
            $tray.Visible = $false
            $tray.Dispose()
            $widget.Close()
            try {
                if ($script:nodeProc -and -not $script:nodeProc.HasExited) {
                    $script:nodeProc.Kill()
                }
            } catch {}
            try { Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue } catch {}
            $mutex.ReleaseMutex()
            [System.Windows.Forms.Application]::Exit()
        }
    })

    $menu.Items.AddRange(@($miOpen, $miCustomer, $miShowWidget, $miHideWidget, $miStatus, $miSep1, $miStartup, $miSep2, $miExit))
    $tray.ContextMenuStrip      = $menu
    $widget.ContextMenuStrip    = $menu
    $pnlMain.ContextMenuStrip   = $menu
    $pbIcon.ContextMenuStrip    = $menu
    $lblTitle.ContextMenuStrip  = $menu
    $lblStatus.ContextMenuStrip = $menu
    $lblHint.ContextMenuStrip   = $menu

    $menu.add_Opening({
        $miStatus.Text = $tray.Text
        if ($widget.Visible) {
            $miShowWidget.Visible = $false
            $miHideWidget.Visible = $true
        } else {
            $miShowWidget.Visible = $true
            $miHideWidget.Visible = $false
        }
    })

    # Tray click handles
    $tray.add_DoubleClick({
        $widget.Show()
        [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
        $widget.BringToFront()
        Open-AdminWindow
    })
    $tray.add_Click({
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            if (-not $widget.Visible) {
                $widget.Show()
                [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
                $widget.BringToFront()
            } else {
                Open-AdminWindow
            }
        }
    })
    $tray.add_BalloonTipClicked({ Open-AdminWindow })

    # --- 12. Wait briefly for server ready, then OPEN WINDOW & WIDGET ---
    $script:serverReady = $false
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 3500) {
        if ($script:nodeProc.HasExited) {
            Show-GuiError "ShopPrint Server Error" "ShopPrint backend process stopped unexpectedly immediately after starting.`nExit code: $($script:nodeProc.ExitCode)"
            break
        }
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:3000/api/admin/auth-status" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                $script:serverReady = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 150
    }

    # Show floating widget (override SW_HIDE from parent process)
    $widget.Show()
    [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
    $widget.BringToFront()

    # Open Admin Console window
    Open-AdminWindow

    # Re-assert widget TopMost so it stays visible on top of browser
    $widget.TopMost = $true
    [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
    $widget.BringToFront()

    if ($script:serverReady) {
        $tray.Text = "ShopPrint - Always Running in Background"
    } else {
        $tray.Text = "ShopPrint - Starting..."
    }

    # --- Show startup balloon so user knows ShopPrint is running in background ---
    $tray.BalloonTipTitle = "ShopPrint is Running"
    $tray.BalloonTipText  = "ShopPrint is running in the background.`nYou can close the browser anytime - printing keeps working.`nClick the tray icon to open admin panel."
    $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
    $tray.ShowBalloonTip(6000)

    # --- 13. Periodic Poller (Job alerts, Printer errors, Live Widget update) ---
    $script:lastPendingCount = 0
    $script:lastFailedCode   = ""

    $pollTimer = New-Object System.Windows.Forms.Timer
    $pollTimer.Interval = 2500
    $pollTimer.add_Tick({
        # Check if Node crashed - restart it
        if ($script:nodeProc -and $script:nodeProc.HasExited) {
            $tray.Text = "ShopPrint - Server restarting..."
            $lblStatus.Text = "[o] Server restarting..."
            $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(239, 68, 68) # Red
            $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
            $widget.Invalidate()

            $script:nodeProc    = Start-NodeServer
            $script:serverReady = $false
            return
        }

        # Check if cloudflared crashed - auto-restart it
        if ($script:cfProc -and $script:cfToken -and $script:cfExePath -and $script:cfProc.HasExited) {
            Log-Debug "cloudflared exited (code $($script:cfProc.ExitCode)), restarting..."
            $psi3 = New-Object System.Diagnostics.ProcessStartInfo
            $psi3.FileName         = $script:cfExePath
            $psi3.Arguments        = "tunnel --protocol http2 run --token `"$($script:cfToken)`""
            $psi3.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
            $psi3.CreateNoWindow   = $true
            $psi3.UseShellExecute  = $false
            $script:cfProc = [System.Diagnostics.Process]::Start($psi3)
            Log-Debug "cloudflared restarted PID: $($script:cfProc.Id)"
        }


        try {
            $res = Invoke-WebRequest -Uri "http://localhost:3000/api/tray/status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            $info = $res.Content | ConvertFrom-Json
            $script:serverReady = $true

            $pending = [int]($info.pendingCount)
            $isPaused = [bool]($info.queuePaused)

            # Check for new print jobs -> notify & update widget!
            if ($pending -gt $script:lastPendingCount) {
                $diff = $pending - $script:lastPendingCount
                $tray.BalloonTipTitle = "New Print Job Received"
                $tray.BalloonTipText  = "$diff new print job(s) waiting for approval. Click to open Admin Panel."
                $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
                $tray.ShowBalloonTip(4000)

                # Auto unhide floating widget on incoming job so shopkeeper sees it
                if (-not $widget.Visible) {
                    $widget.Show()
                    [WinHelper]::ShowWindow($widget.Handle, [WinHelper]::SW_SHOW) | Out-Null
                }
                $widget.BringToFront()
            }
            $script:lastPendingCount = $pending

            # Check for printer errors
            if ($info.latestFailed -and $info.latestFailed.code -ne $script:lastFailedCode) {
                $script:lastFailedCode = [string]($info.latestFailed.code)
                $reason = [string]($info.latestFailed.failure_reason)
                $tray.BalloonTipTitle = "Printer Alert - Job Failed"
                $tray.BalloonTipText  = "Job #$($script:lastFailedCode) error: $reason. Click to check."
                $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Error
                $tray.ShowBalloonTip(6000)

                $lblStatus.Text = "[!] Job #$($script:lastFailedCode) Failed"
                $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(239, 68, 68) # Red
                $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
                $widget.Invalidate()
            } elseif ($isPaused) {
                $tray.Text = "ShopPrint - Queue Paused (Background)"
                $lblStatus.Text = "[||] Queue Paused ($pending)"
                $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(245, 158, 11) # Amber
                $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
                $widget.Invalidate()
            } elseif ($pending -gt 0) {
                $tray.Text = "ShopPrint - $pending Job(s) (Background)"
                $lblStatus.Text = "[*] $pending Job(s) Waiting"
                $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(59, 130, 246) # Blue
                $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(59, 130, 246)
                $widget.Invalidate()
            } else {
                $tray.Text = "ShopPrint - Ready (Background Active)"
                $lblStatus.Text = "[o] Ready for prints"
                $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(16, 185, 129) # Emerald Green
                $script:widgetBorderColor = [System.Drawing.Color]::FromArgb(59, 130, 246)
                $widget.Invalidate()
            }
        } catch {
            $tray.Text = "ShopPrint - Connecting..."
            $lblStatus.Text = "[o] Connecting..."
            $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
            $widget.Invalidate()
        }
    })
    $pollTimer.Start()

    Log-Debug "Widget handle: $($widget.Handle), Visible: $($widget.Visible), Bounds: $($widget.Bounds)"
    Log-Debug "Entering Application::Run()..."

    # Run Windows GUI message loop
    [System.Windows.Forms.Application]::Run()

} catch {
    Log-Debug "FATAL EXCEPTION: $($_.Exception.ToString()) at line $($_.InvocationInfo.ScriptLineNumber)"
    Show-GuiError "ShopPrint - Unexpected Error" "An error occurred while running ShopPrint:`n`n$($_.Exception.Message)`n`nAt line $($_.InvocationInfo.ScriptLineNumber)"
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
}
