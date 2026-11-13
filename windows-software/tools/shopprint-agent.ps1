# ============================================================
#  QrPrintDesk Agent  (QrPrintDesk-agent.ps1)
#  Lightweight Windows print station â€” no local HTTP server.
#  Connects to QrPrintDesk Cloud Control Plane via WebSocket.
#  First run: registration dialog. Config stored in data\config.json
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

$ErrorActionPreference = 'Stop'

# â”€â”€ Paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ((Split-Path -Leaf $ScriptDir) -eq 'tools') { $ScriptDir = Split-Path -Parent $ScriptDir }
$ConfigPath  = "$ScriptDir\data\config.json"
$LogPath     = "$ScriptDir\data\agent.log"
$TmpDir      = "$ScriptDir\data\tmp"
$SumatraExe  = "$ScriptDir\bin\SumatraPDF.exe"

@($TmpDir, "$ScriptDir\data") | ForEach-Object { if (-not (Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null } }

# â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Write-Log([string]$level, [string]$msg) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts][$level] $msg"
    Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue
    if ($level -ne 'DEBUG') { Write-Host $line }
}

# â”€â”€ Config helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Read-Config {
    if (Test-Path $ConfigPath) {
        try { return Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

function Save-Config($cfg) {
    $cfg | ConvertTo-Json -Depth 5 | Set-Content $ConfigPath -Encoding UTF8
}

# â”€â”€ HTTP helpers (no Node.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Invoke-Api([string]$method, [string]$url, $body = $null, [string]$token = '') {
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $params = @{ Method = $method; Uri = $url; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 15; ErrorAction = 'Stop' }
    if ($body) { $params['Body'] = ($body | ConvertTo-Json -Compress) }
    $r = Invoke-WebRequest @params
    return $r.Content | ConvertFrom-Json
}

function Download-File([string]$url, [string]$dest) {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($url, $dest)
    $wc.Dispose()
}

# â”€â”€ SumatraPDF print â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Print-Document([string]$filePath, $opts) {
    if (-not (Test-Path $SumatraExe)) {
        Write-Log 'ERROR' "SumatraPDF not found at $SumatraExe"
        return $false
    }
    # Build print args compliant with SumatraPDF CLI
    $printer  = if ($opts.printerName) { $opts.printerName } else { '' }
    $copies   = if ($opts.copies -gt 1) { [int]$opts.copies } else { 1 }
    $duplex   = $opts.duplexMode  # 'simplex' | 'duplexlong' | 'duplexshort'
    if (-not $duplex) { $duplex = $opts.duplex }
    $paper    = if ($opts.paperSize) { $opts.paperSize } else { 'A4' }

    $settingParts = @('fit', "paper=$paper")
    if ($opts.orientation -eq 'landscape') { $settingParts += 'landscape' }
    elseif ($opts.orientation -eq 'portrait') { $settingParts += 'portrait' }
    if ($duplex -eq 'duplexlong')  { $settingParts += 'duplex' }
    if ($duplex -eq 'duplexshort') { $settingParts += 'duplexshort' }
    if ($copies -gt 1)             { $settingParts += "${copies}x" }
    $settingStr = $settingParts -join ','

    $printArg = if ($printer) { "-print-to `"$printer`"" } else { "-print-to-default" }
    $cmd = "`"$SumatraExe`" $printArg -print-settings `"$settingStr`" -silent -exit-when-done `"$filePath`""

    Write-Log 'INFO' "Printing: $cmd"
    try {
        $argList = @()
        if ($printer) {
            $argList += @("-print-to", $printer)
        } else {
            $argList += "-print-to-default"
        }
        $argList += @("-print-settings", $settingStr, "-silent", "-exit-when-done", $filePath)

        $p = Start-Process -FilePath $SumatraExe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
        Write-Log 'INFO' "SumatraPDF exit code: $($p.ExitCode)"
        return ($p.ExitCode -eq 0)
    } catch {
        Write-Log 'ERROR' "Print failed: $($_.Exception.Message)"
        return $false
    }
}

# â”€â”€ Process one print job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$script:processingJobs = [System.Collections.Concurrent.ConcurrentDictionary[string,bool]]::new()

function Process-Job([string]$jobId, [string]$serverUrl, [string]$token) {
    if (-not $script:processingJobs.TryAdd($jobId, $true)) {
        Write-Log 'DEBUG' "Job $jobId already processing â€” skip"
        return
    }
    try {
        Write-Log 'INFO' "Processing job $jobId"
        # 1. Get download URLs
        $meta = Invoke-Api 'GET' "$serverUrl/api/agent/jobs/$jobId/download-url" -token $token

        foreach ($file in $meta.files) {
            $ext     = [System.IO.Path]::GetExtension($file.originalFilename)
            $tmpFile = "$TmpDir\$jobId$ext"
            Write-Log 'INFO' "Downloading $($file.originalFilename) ($($file.fileSize) bytes)"
            Download-File $file.downloadUrl $tmpFile

            $opts = $meta.printOptions
            $opts | Add-Member -NotePropertyName 'originalFilename' -NotePropertyValue $file.originalFilename -Force

            $ok = Print-Document $tmpFile $opts

            # 2. Report outcome
            $outcome = if ($ok) { 'SUCCESS' } else { 'UNCERTAIN' }
            $opId    = [System.Guid]::NewGuid().ToString()
            try {
                Invoke-Api 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome = $outcome; opId = $opId } -token $token | Out-Null
            } catch { Write-Log 'WARN' "Status report failed: $($_.Exception.Message)" }

            # 3. Cleanup temp file
            Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue

            Write-Log 'INFO' "Job $jobId â†’ $outcome"
        }
    } catch {
        Write-Log 'ERROR' "Job $jobId failed: $($_.Exception.Message)"
        try { Invoke-Api 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome = 'UNCERTAIN'; reason = $_.Exception.Message } -token $token | Out-Null } catch {}
    } finally {
        $script:processingJobs.TryRemove($jobId, [ref]$null) | Out-Null
    }
}

# â”€â”€ Sync pending jobs on reconnect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Sync-PendingJobs([string]$serverUrl, [string]$token) {
    try {
        $res = Invoke-Api 'GET' "$serverUrl/api/agent/jobs?limit=20" -token $token
        foreach ($j in $res.jobs) {
            $id = $j.jobId
            [System.Threading.ThreadPool]::QueueUserWorkItem({ param($jid) Process-Job $jid $serverUrl $token }, $id) | Out-Null
        }
        Write-Log 'INFO' "Synced $($res.jobs.Count) pending job(s)"
    } catch { Write-Log 'WARN' "Sync failed: $($_.Exception.Message)" }
}

# â”€â”€ Registration dialog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Show-RegistrationDialog {
    $frm = New-Object System.Windows.Forms.Form
    $frm.Text          = 'QrPrintDesk â€” Station Setup'
    $frm.Size          = New-Object System.Drawing.Size(440, 380)
    $frm.StartPosition = 'CenterScreen'
    $frm.FormBorderStyle = 'FixedDialog'
    $frm.MaximizeBox   = $false
    $frm.MinimizeBox   = $false
    $frm.BackColor     = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $frm.ForeColor     = [System.Drawing.Color]::White
    $frm.Font          = New-Object System.Drawing.Font('Segoe UI', 10)

    $makeLbl = {
        param([string]$text, [int]$y)
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Location = New-Object System.Drawing.Point(30, $y)
        $l.Size = New-Object System.Drawing.Size(370, 20)
        $l.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
        $l.Font = New-Object System.Drawing.Font('Segoe UI', 8)
        $frm.Controls.Add($l)
    }
    $makeTxt = {
        param([string]$placeholder, [int]$y, [bool]$pwd=$false)
        $t = New-Object System.Windows.Forms.TextBox
        $t.Location = New-Object System.Drawing.Point(30, $y)
        $t.Size = New-Object System.Drawing.Size(370, 28)
        $t.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        $t.ForeColor = [System.Drawing.Color]::White
        $t.BorderStyle = 'FixedSingle'
        $t.Font = New-Object System.Drawing.Font('Segoe UI', 10)
        if ($pwd) { $t.PasswordChar = 'â—' }
        $frm.Controls.Add($t)
        return $t
    }

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'â˜  Connect to Cloud Server'
    $title.Location = New-Object System.Drawing.Point(30, 20)
    $title.Size = New-Object System.Drawing.Size(370, 30)
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
    $title.ForeColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
    $frm.Controls.Add($title)

    $sub = New-Object System.Windows.Forms.Label
    $sub.Text = 'Enter your server URL and shop credentials to register this print station.'
    $sub.Location = New-Object System.Drawing.Point(30, 52)
    $sub.Size = New-Object System.Drawing.Size(370, 32)
    $sub.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
    $sub.Font = New-Object System.Drawing.Font('Segoe UI', 8)
    $frm.Controls.Add($sub)

    & $makeLbl 'Cloud Server URL' 94
    $txtUrl = & $makeTxt 'http://localhost:3000' 114
    $txtUrl.Text = 'http://localhost:3000'

    & $makeLbl 'Shop Slug (e.g. default)' 154
    $txtSlug = & $makeTxt 'default' 174
    $txtSlug.Text = 'default'

    & $makeLbl 'Shop PIN' 214
    $txtPin = & $makeTxt '' 234 $true

    & $makeLbl 'Station Name (e.g. Main Counter)' 274
    $txtName = & $makeTxt 'Main Counter' 294
    $txtName.Text = 'Main Counter'

    $errLbl = New-Object System.Windows.Forms.Label
    $errLbl.Location = New-Object System.Drawing.Point(30, 295)
    $errLbl.Size = New-Object System.Drawing.Size(370, 20)
    $errLbl.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    $errLbl.Font = New-Object System.Drawing.Font('Segoe UI', 8)
    $frm.Controls.Add($errLbl)

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = 'Register This Station'
    $btn.Location = New-Object System.Drawing.Point(30, 320)
    $btn.Size = New-Object System.Drawing.Size(370, 36)
    $btn.BackColor = [System.Drawing.Color]::FromArgb(29, 78, 216)
    $btn.ForeColor = [System.Drawing.Color]::White
    $btn.FlatStyle = 'Flat'
    $btn.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
    $frm.Controls.Add($btn)
    $frm.AcceptButton = $btn

    $result = $null

    $btn.add_Click({
        $errLbl.Text = ''
        $serverUrl = $txtUrl.Text.Trim().TrimEnd('/')
        $slug      = $txtSlug.Text.Trim()
        $pin       = $txtPin.Text.Trim()
        $name      = $txtName.Text.Trim()

        if (-not $serverUrl -or -not $slug -or -not $pin -or -not $name) {
            $errLbl.Text = 'All fields are required.'
            return
        }

        $btn.Text    = 'Registering...'
        $btn.Enabled = $false
        try {
            $body = @{ shopSlug = $slug; pin = $pin; agentName = $name } | ConvertTo-Json -Compress
            $headers = @{ 'Content-Type' = 'application/json' }
            $r = Invoke-WebRequest -Method POST -Uri "$serverUrl/api/auth/agent/self-register" `
                -Body $body -Headers $headers -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
            $data = $r.Content | ConvertFrom-Json
            $cfg = [PSCustomObject]@{
                serverUrl  = $serverUrl
                agentToken = $data.agentToken
                agentId    = $data.agentId
                agentName  = $data.agentName
                shopId     = $data.shopId
                shopName   = $data.shopName
            }
            Save-Config $cfg
            $script:registeredConfig = $cfg
            $frm.DialogResult = 'OK'
            $frm.Close()
        } catch {
            $msg = $_.Exception.Message
            try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
            $errLbl.Text = "Error: $msg"
            $btn.Text    = 'Register This Station'
            $btn.Enabled = $true
        }
    })

    $frm.ShowDialog() | Out-Null
    return $script:registeredConfig
}

# â”€â”€ Tray icon + floating widget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$script:wsConnected = $false
$script:lastJobTime = $null
$script:jobCount    = 0

function Build-TrayApp([PSCustomObject]$cfg) {
    # Tray icon
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $icoPath = "$ScriptDir\app.ico"
    if (-not (Test-Path $icoPath)) { $icoPath = "$ScriptDir\public\app.ico" }
    if (Test-Path $icoPath) {
        try { $tray.Icon = New-Object System.Drawing.Icon($icoPath) } catch {}
    }
    if (-not $tray.Icon) {
        $bmp = New-Object System.Drawing.Bitmap(32,32)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 0,0,32,32)
        $g.FillEllipse([System.Drawing.Brushes]::White, 6,10,20,12)
        $g.Dispose()
        $tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    }
    $tray.Text    = 'QrPrintDesk Agent'
    $tray.Visible = $true

    # Floating status widget
    $widget = New-Object System.Windows.Forms.Form
    $widget.Text            = 'QrPrintDesk'
    $widget.Size            = New-Object System.Drawing.Size(260, 110)
    $widget.FormBorderStyle = 'None'
    $widget.TopMost         = $true
    $widget.StartPosition   = 'Manual'
    $widget.Location        = New-Object System.Drawing.Point(([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width - 270), 40)
    $widget.BackColor       = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $widget.Opacity         = 0.95

    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text      = "â˜  $($cfg.shopName)"
    $lblTitle.Location  = New-Object System.Drawing.Point(12, 10)
    $lblTitle.Size      = New-Object System.Drawing.Size(230, 22)
    $lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
    $lblTitle.Font      = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $widget.Controls.Add($lblTitle)

    $lblStatus = New-Object System.Windows.Forms.Label
    $lblStatus.Text      = 'Connecting...'
    $lblStatus.Location  = New-Object System.Drawing.Point(12, 36)
    $lblStatus.Size      = New-Object System.Drawing.Size(230, 20)
    $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $lblStatus.Font      = New-Object System.Drawing.Font('Segoe UI', 8)
    $widget.Controls.Add($lblStatus)

    $lblAgent = New-Object System.Windows.Forms.Label
    $lblAgent.Text      = $cfg.agentName
    $lblAgent.Location  = New-Object System.Drawing.Point(12, 56)
    $lblAgent.Size      = New-Object System.Drawing.Size(230, 18)
    $lblAgent.ForeColor = [System.Drawing.Color]::FromArgb(71, 85, 105)
    $lblAgent.Font      = New-Object System.Drawing.Font('Segoe UI', 7)
    $widget.Controls.Add($lblAgent)

    $lblJobs = New-Object System.Windows.Forms.Label
    $lblJobs.Text      = 'Jobs printed: 0'
    $lblJobs.Location  = New-Object System.Drawing.Point(12, 74)
    $lblJobs.Size      = New-Object System.Drawing.Size(230, 18)
    $lblJobs.ForeColor = [System.Drawing.Color]::FromArgb(71, 85, 105)
    $lblJobs.Font      = New-Object System.Drawing.Font('Segoe UI', 7)
    $widget.Controls.Add($lblJobs)

    # Drag support
    $script:dragging = $false; $script:dragStart = $null
    $widget.add_MouseDown({ $script:dragging = $true; $script:dragStart = [System.Windows.Forms.Cursor]::Position })
    $widget.add_MouseMove({
        if ($script:dragging) {
            $cur = [System.Windows.Forms.Cursor]::Position
            $widget.Location = New-Object System.Drawing.Point(
                ($widget.Location.X + $cur.X - $script:dragStart.X),
                ($widget.Location.Y + $cur.Y - $script:dragStart.Y))
            $script:dragStart = $cur
        }
    })
    $widget.add_MouseUp({ $script:dragging = $false })

    # Tray context menu
    $menu  = New-Object System.Windows.Forms.ContextMenuStrip
    $miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
    $miStatus.Text = "Server: $($cfg.serverUrl)"
    $miStatus.Enabled = $false
    $menu.Items.Add($miStatus) | Out-Null

    $miSep = New-Object System.Windows.Forms.ToolStripSeparator
    $menu.Items.Add($miSep) | Out-Null

    $miWidget = New-Object System.Windows.Forms.ToolStripMenuItem
    $miWidget.Text = 'Show / Hide Status Bar'
    $miWidget.add_Click({ if ($widget.Visible) { $widget.Hide() } else { $widget.Show() } })
    $menu.Items.Add($miWidget) | Out-Null

    $miOpenDash = New-Object System.Windows.Forms.ToolStripMenuItem
    $miOpenDash.Text = 'Open Cloud Dashboard'
    $miOpenDash.add_Click({ Start-Process "$($cfg.serverUrl)/status" })
    $menu.Items.Add($miOpenDash) | Out-Null

    $miSep2 = New-Object System.Windows.Forms.ToolStripSeparator
    $menu.Items.Add($miSep2) | Out-Null

    $miReset = New-Object System.Windows.Forms.ToolStripMenuItem
    $miReset.Text = 'Reset Registration...'
    $miReset.add_Click({
        $confirm = [System.Windows.Forms.MessageBox]::Show(
            "This will remove your saved credentials.`nYou will need to re-register on next launch.",
            'Reset Registration', 'YesNo', 'Warning')
        if ($confirm -eq 'Yes') {
            Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
            $tray.Visible = $false
            $widget.Close()
            [System.Windows.Forms.Application]::Exit()
        }
    })
    $menu.Items.Add($miReset) | Out-Null

    $miExit = New-Object System.Windows.Forms.ToolStripMenuItem
    $miExit.Text = 'Exit'
    $miExit.add_Click({
        $tray.Visible = $false
        $widget.Close()
        [System.Windows.Forms.Application]::Exit()
    })
    $menu.Items.Add($miExit) | Out-Null

    $tray.ContextMenuStrip = $menu
    $tray.add_DoubleClick({ if ($widget.Visible) { $widget.Hide() } else { $widget.Show() } })

    $widget.Show()

    # â”€â”€ WebSocket background runspace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $rs.ApartmentState = 'MTA'
    $rs.ThreadOptions  = 'ReuseThread'
    $rs.Open()

    $rs.SessionStateProxy.SetVariable('serverUrl',  $cfg.serverUrl)
    $rs.SessionStateProxy.SetVariable('agentToken', $cfg.agentToken)
    $rs.SessionStateProxy.SetVariable('scriptDir',  $ScriptDir)
    $rs.SessionStateProxy.SetVariable('tmpDir',     $TmpDir)
    $rs.SessionStateProxy.SetVariable('sumatraExe', $SumatraExe)
    $rs.SessionStateProxy.SetVariable('logPath',    $LogPath)
    $rs.SessionStateProxy.SetVariable('statusRef',  ([ref]$script:wsConnected))
    $rs.SessionStateProxy.SetVariable('jobCountRef',([ref]$script:jobCount))

    $wsScript = {
        function WS-Log([string]$msg) {
            $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            Add-Content -Path $logPath -Value "[$ts][WS] $msg" -ErrorAction SilentlyContinue
        }
        function Api-Call([string]$method, [string]$url, $body=$null, [string]$token='') {
            $h = @{ 'Content-Type'='application/json' }
            if ($token) { $h['Authorization'] = "Bearer $token" }
            $p = @{ Method=$method; Uri=$url; Headers=$h; UseBasicParsing=$true; TimeoutSec=15; ErrorAction='Stop' }
            if ($body) { $p['Body'] = ($body | ConvertTo-Json -Compress) }
            return (Invoke-WebRequest @p).Content | ConvertFrom-Json
        }
        function Do-Print([string]$filePath, $opts) {
            $printer = if ($opts.printerName) { $opts.printerName } else { '' }
            $copies  = if ($opts.copies -and $opts.copies -gt 1) { [int]$opts.copies } else { 1 }
            $paper   = if ($opts.paperSize) { $opts.paperSize } else { 'A4' }
            $settingParts = @("paper=$paper")
            if ($opts.duplex -eq 'duplexlong')  { $settingParts += 'duplex' }
            if ($opts.duplex -eq 'duplexshort') { $settingParts += 'duplexshort' }
            if ($opts.color -eq 'color')        { $settingParts += 'color' } else { $settingParts += 'monochrome' }
            if ($copies -gt 1)                  { $settingParts += "copies=$copies" }
            $settingStr = $settingParts -join ','
            $args = @('-print-settings', $settingStr, '-silent', '-exit-when-done')
            if ($printer) { $args = @('-print-to', "`"$printer`"") + $args } else { $args = @('-print-to-default') + $args }
            $args += "`"$filePath`""
            WS-Log "SumatraPDF $($args -join ' ')"
            $p = Start-Process -FilePath $sumatraExe -ArgumentList $args -Wait -PassThru -WindowStyle Hidden
            return ($p.ExitCode -eq 0)
        }
        function Process-CloudJob([string]$jobId) {
            WS-Log "Processing job $jobId"
            try {
                $meta = Api-Call 'GET' "$serverUrl/api/agent/jobs/$jobId/download-url" -token $agentToken
                foreach ($file in $meta.files) {
                    $ext  = [System.IO.Path]::GetExtension($file.originalFilename)
                    if (-not $ext) { $ext = '.pdf' }
                    $tmp  = "$tmpDir\$jobId$ext"
                    WS-Log "Downloading $($file.originalFilename)"
                    $wc = New-Object System.Net.WebClient
                    $wc.DownloadFile($file.downloadUrl, $tmp)
                    $wc.Dispose()
                    $ok  = Do-Print $tmp $meta.printOptions
                    $outcome = if ($ok) { 'SUCCESS' } else { 'UNCERTAIN' }
                    $opId = [System.Guid]::NewGuid().ToString()
                    try { Api-Call 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome=$outcome; opId=$opId } -token $agentToken | Out-Null } catch {}
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                    WS-Log "Job $jobId â†’ $outcome"
                    $jobCountRef.Value++
                }
            } catch {
                WS-Log "Job $jobId error: $($_.Exception.Message)"
                try { Api-Call 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome='UNCERTAIN'; reason=$_.Exception.Message } -token $agentToken | Out-Null } catch {}
            }
        }
        function Sync-Pending {
            try {
                $res = Api-Call 'GET' "$serverUrl/api/agent/jobs?limit=20" -token $agentToken
                foreach ($j in $res.jobs) { Process-CloudJob $j.jobId }
                WS-Log "Synced $($res.jobs.Count) pending job(s)"
            } catch { WS-Log "Sync error: $($_.Exception.Message)" }
        }

        # WebSocket loop with auto-reconnect
        while ($true) {
            try {
                $wsUrl = $serverUrl -replace '^http','ws'
                $wsUrl = "$wsUrl/ws/agent?token=$([Uri]::EscapeDataString($agentToken))"
                $ws    = New-Object System.Net.WebSockets.ClientWebSocket
                $cts   = New-Object System.Threading.CancellationTokenSource
                $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
                $statusRef.Value = $true
                WS-Log "WebSocket connected to $serverUrl"

                # Sync any pending jobs on (re)connect
                Sync-Pending

                $buffer  = New-Object byte[] 8192
                $segment = New-Object ArraySegment[byte] $buffer
                $sb      = New-Object System.Text.StringBuilder

                while ($ws.State -eq 'Open') {
                    $result = $ws.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
                    if ($result.MessageType -eq 'Close') {
                        $ws.CloseAsync('NormalClosure','', $cts.Token).GetAwaiter().GetResult()
                        break
                    }
                    $sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)) | Out-Null
                    if ($result.EndOfMessage) {
                        $raw = $sb.ToString(); $sb.Clear()
                        try {
                            $msg = $raw | ConvertFrom-Json
                            if ($msg.type -eq 'job' -and $msg.id) {
                                $jid = $msg.id
                                [System.Threading.Tasks.Task]::Run({ Process-CloudJob $jid }) | Out-Null
                            }
                        } catch {}
                    }
                }
            } catch {
                WS-Log "WebSocket error: $($_.Exception.Message)"
            }
            $statusRef.Value = $false
            WS-Log 'Disconnected. Reconnecting in 6s...'
            Start-Sleep -Seconds 6
        }
    }

    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $rs
    $ps.AddScript($wsScript) | Out-Null
    $ps.BeginInvoke() | Out-Null

    # â”€â”€ UI polling timer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 2000
    $timer.add_Tick({
        if ($script:wsConnected) {
            $lblStatus.Text      = "â— Connected to $($cfg.serverUrl)"
            $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
            $tray.Text           = 'QrPrintDesk Agent â€” Connected'
        } else {
            $lblStatus.Text      = 'â—‹ Connecting...'
            $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
            $tray.Text           = 'QrPrintDesk Agent â€” Offline'
        }
        $lblJobs.Text = "Jobs printed this session: $($script:jobCount)"
    })
    $timer.Start()

    $widget.add_FormClosed({
        $timer.Stop()
        $tray.Visible = $false
        try { $ps.Stop(); $rs.Close() } catch {}
    })

    # Show startup balloon
    $tray.BalloonTipTitle = 'QrPrintDesk Agent Running'
    $tray.BalloonTipText  = "Connected to: $($cfg.serverUrl)`nStation: $($cfg.agentName)"
    $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
    $tray.ShowBalloonTip(5000)

    [System.Windows.Forms.Application]::Run($widget)
}

# â”€â”€ Entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
try {
    $cfg = Read-Config
    if (-not $cfg -or -not $cfg.agentToken) {
        Write-Log 'INFO' 'No config found â€” showing registration dialog'
        $cfg = Show-RegistrationDialog
        if (-not $cfg) { Write-Log 'WARN' 'Registration cancelled.'; exit 0 }
        Write-Log 'INFO' "Registered as '$($cfg.agentName)' on $($cfg.serverUrl)"
    } else {
        Write-Log 'INFO' "Config loaded. Agent='$($cfg.agentName)' Server='$($cfg.serverUrl)'"
    }
    Build-TrayApp $cfg
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "QrPrintDesk Agent crashed:`n$($_.Exception.Message)",
        'QrPrintDesk Error', 'OK', 'Error') | Out-Null
    exit 1
}
