# ============================================================
#  QrPrintDesk Vendor Dashboard (QrPrintDesk-vendor.ps1)
#  Full-featured vendor app - setup wizard + live dashboard.
#  Pure PowerShell + WinForms. No Node.js required on vendor PC.
#  First run -> vendor registration wizard -> saves config.json
#  Subsequent runs -> full tabbed dashboard with live stats.
# ============================================================
#Requires -Version 5.1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Stop'

# -- Paths ----------------------------------------------------
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    if ($MyInvocation.MyCommand.Path) {
        $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition -ErrorAction SilentlyContinue
    }
}
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
if ((Split-Path -Leaf $ScriptDir) -eq 'tools') { $ScriptDir = Split-Path -Parent $ScriptDir }

$ConfigPath = "$ScriptDir\data\config.json"
$LogPath    = "$ScriptDir\data\vendor.log"
$TmpDir     = "$ScriptDir\data\tmp"
$SumatraExe = "$ScriptDir\bin\SumatraPDF.exe"

@($TmpDir, "$ScriptDir\data") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
}

# -- Shared state ---------------------------------------------
$script:wsConnected = $false
$script:jobCount    = 0
$script:pendingJobs = 0
$script:dashData    = $null

# -- Color Palette ---------------------------------------------
$script:C = @{
    BgDeep    = [System.Drawing.Color]::FromArgb(10, 15, 28)
    BgCard    = [System.Drawing.Color]::FromArgb(20, 30, 50)
    BgPanel   = [System.Drawing.Color]::FromArgb(15, 23, 42)
    BgInput   = [System.Drawing.Color]::FromArgb(26, 38, 58)
    Border    = [System.Drawing.Color]::FromArgb(40, 60, 90)
    Blue      = [System.Drawing.Color]::FromArgb(59, 130, 246)
    BlueHov   = [System.Drawing.Color]::FromArgb(29, 78, 216)
    Green     = [System.Drawing.Color]::FromArgb(34, 197, 94)
    Amber     = [System.Drawing.Color]::FromArgb(251, 191, 36)
    Red       = [System.Drawing.Color]::FromArgb(239, 68, 68)
    TextPri   = [System.Drawing.Color]::White
    TextSec   = [System.Drawing.Color]::FromArgb(148, 163, 184)
    TextDim   = [System.Drawing.Color]::FromArgb(71, 85, 105)
    Accent    = [System.Drawing.Color]::FromArgb(96, 165, 250)
}
$C = $script:C

# -- Fonts ----------------------------------------------------
$script:F = @{
    Title     = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
    Heading   = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    Body      = New-Object System.Drawing.Font('Segoe UI', 9)
    Small     = New-Object System.Drawing.Font('Segoe UI', 8)
    Mono      = New-Object System.Drawing.Font('Consolas', 9)
    BigNum    = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
    Input     = New-Object System.Drawing.Font('Segoe UI', 10)
    BtnText   = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
}
$F = $script:F

# -- Logging --------------------------------------------------
function Write-Log([string]$level, [string]$msg) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts][$level] $msg"
    Add-Content -Path $LogPath -Value $line -ErrorAction SilentlyContinue
    if ($level -ne 'DEBUG') { Write-Host $line }
}

# -- Config helpers -------------------------------------------
function Read-Config {
    if (Test-Path $ConfigPath) {
        try { return Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}
function Save-Config($cfg) {
    $cfg | ConvertTo-Json -Depth 5 | Set-Content $ConfigPath -Encoding UTF8
}

# -- HTTP helpers ----------------------------------------------
function Invoke-Api([string]$method, [string]$url, $body = $null, [string]$token = '') {
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $params = @{
        Method          = $method
        Uri             = $url
        Headers         = $headers
        UseBasicParsing = $true
        TimeoutSec      = 20
        ErrorAction     = 'Stop'
    }
    if ($body) { $params['Body'] = ($body | ConvertTo-Json -Compress) }
    $r = Invoke-WebRequest @params
    return $r.Content | ConvertFrom-Json
}

# -- Image Auto-Enhancement Engine (Pure GDI+) -----------------
$script:EnhanceDocCode = @'
function Enhance-DocumentImage([string]$sourcePath, [string]$destPath, [string]$colorMode = 'monochrome') {
    $img = $null; $canvas = $null; $g = $null; $ms = $null
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sourcePath)
        $ms = New-Object System.IO.MemoryStream(,$bytes)
        $img = [System.Drawing.Image]::FromStream($ms)

        # 1. EXIF Auto-Orientation
        try {
            $prop = $img.GetPropertyItem(0x0112)
            if ($prop) {
                $val = [System.BitConverter]::ToUInt16($prop.Value, 0)
                switch ($val) {
                    3 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
                    6 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
                    8 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
                }
            }
        } catch {}

        # 2. Standard A4 Canvas at 300 DPI (2480 x 3508 px)
        $a4W = 2480; $a4H = 3508
        $isLandscape = ($img.Width -gt $img.Height)
        $targetW = if ($isLandscape) { $a4H } else { $a4W }
        $targetH = if ($isLandscape) { $a4W } else { $a4H }

        # Safe Margin (100 px = ~8.5 mm) prevents hardware printer clipping
        $margin = 100
        $availW = $targetW - (2 * $margin)
        $availH = $targetH - (2 * $margin)

        $scale = [Math]::Min([double]$availW / $img.Width, [double]$availH / $img.Height)
        $drawW = [int]($img.Width * $scale)
        $drawH = [int]($img.Height * $scale)
        $drawX = $margin + [int](($availW - $drawW) / 2)
        $drawY = $margin + [int](($availH - $drawH) / 2)

        # 3. Canvas
        $canvas = New-Object System.Drawing.Bitmap($targetW, $targetH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $canvas.SetResolution(300, 300)
        $g = [System.Drawing.Graphics]::FromImage($canvas)
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

        # 4. Color Matrix Enhancement
        $ia = New-Object System.Drawing.Imaging.ImageAttributes
        if ($colorMode -eq 'monochrome' -or $colorMode -eq 'bw') {
            # Whitens shadowy yellow paper, deep darkens text for photocopy clarity
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
            # Color Mode: Vibrant contrast without washout
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
        $destRect = New-Object System.Drawing.Rectangle($drawX, $drawY, $drawW, $drawH)
        $g.DrawImage($img, $destRect, 0, 0, $img.Width, $img.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)

        # 6. Save as High-Quality JPEG
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
        $canvas.Save($destPath, $codec, $encParams)
        return $true
    } catch {
        return $false
    } finally {
        if ($g)      { try { $g.Dispose() } catch {} }
        if ($canvas) { try { $canvas.Dispose() } catch {} }
        if ($img)    { try { $img.Dispose() } catch {} }
        if ($ms)     { try { $ms.Dispose() } catch {} }
    }
}
'@
. ([scriptblock]::Create($script:EnhanceDocCode))

# -- UI Builder helpers ----------------------------------------
function New-Label([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, $font = $null, $color = $null) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text      = $text
    $l.Location  = New-Object System.Drawing.Point($x, $y)
    $l.Size      = New-Object System.Drawing.Size($w, $h)
    $l.Font      = if ($font -is [System.Drawing.Font]) { $font } else { $script:F.Body }
    $l.ForeColor = if ($color -is [System.Drawing.Color]) { $color } else { $script:C.TextPri }
    $l.BackColor = [System.Drawing.Color]::Transparent
    return $l
}

function New-Txt([string]$text, [int]$x, [int]$y, [int]$w, [bool]$pwd = $false) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Text      = $text
    $t.Location  = New-Object System.Drawing.Point($x, $y)
    $t.Size      = New-Object System.Drawing.Size($w, 30)
    $t.BackColor = $script:C.BgInput
    $t.ForeColor = $script:C.TextPri
    $t.BorderStyle = 'FixedSingle'
    $t.Font      = $script:F.Input
    if ($pwd) { $t.PasswordChar = '*' }
    return $t
}

function New-Btn([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, $bg = $null, $fg = $null) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text      = $text
    $b.Location  = New-Object System.Drawing.Point($x, $y)
    $b.Size      = New-Object System.Drawing.Size($w, $h)
    $b.BackColor = if ($bg -is [System.Drawing.Color]) { $bg } else { $script:C.Blue }
    $b.ForeColor = if ($fg -is [System.Drawing.Color]) { $fg } else { $script:C.TextPri }
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Font      = $script:F.BtnText
    $b.Cursor    = [System.Windows.Forms.Cursors]::Hand
    return $b
}

function New-StatCard([System.Windows.Forms.Control]$parent, [int]$x, [int]$y, [string]$label, [string]$value, $valColor = $null, [string]$sub = '') {
    $card = New-Object System.Windows.Forms.Panel
    $card.Location  = New-Object System.Drawing.Point($x, $y)
    $card.Size      = New-Object System.Drawing.Size(195, 95)
    $card.BackColor = $script:C.BgCard

    $lbl = New-Label $label 12 8 170 18 $script:F.Small $script:C.TextDim
    $statCol = if ($valColor -is [System.Drawing.Color]) { $valColor } else { $script:C.TextPri }
    $val = New-Label $value 12 28 170 36 $script:F.BigNum $statCol
    $val.AutoSize = $false
    $val.TextAlign = 'MiddleLeft'

    $subLbl = New-Label $sub 12 68 170 18 $script:F.Small $script:C.TextDim
    $subLbl.AutoSize = $false

    $card.Controls.Add($lbl)
    $card.Controls.Add($val)
    $card.Controls.Add($subLbl)
    $parent.Controls.Add($card)
    return @{ card = $card; valLabel = $val; subLabel = $subLbl }
}

# ================================================================
#   STEP 1 - SETUP WIZARD (full vendor registration)
# ================================================================
function Show-SetupWizard {
    $frm = New-Object System.Windows.Forms.Form
    $frm.Text            = 'QrPrintDesk - First Time Setup'
    $frm.Size            = New-Object System.Drawing.Size(520, 600)
    $frm.StartPosition   = 'CenterScreen'
    $frm.FormBorderStyle = 'FixedDialog'
    $frm.MaximizeBox     = $false
    $frm.MinimizeBox     = $false
    $frm.BackColor       = $C.BgPanel

    # -- Header -------------------------------------------------
    $pnlHeader = New-Object System.Windows.Forms.Panel
    $pnlHeader.Dock      = 'Top'
    $pnlHeader.Height    = 100
    $pnlHeader.BackColor = $C.BgDeep
    $frm.Controls.Add($pnlHeader)

    $lblBrand = New-Label 'QrPrintDesk' 30 18 300 38 $F.Title $C.Accent
    $pnlHeader.Controls.Add($lblBrand)
    $lblSub = New-Label 'Vendor Setup - Register your print shop station' 30 60 420 22 $F.Body $C.TextSec
    $pnlHeader.Controls.Add($lblSub)

    # -- Form body ----------------------------------------------
    $pnlBody = New-Object System.Windows.Forms.Panel
    $pnlBody.Location = New-Object System.Drawing.Point(0, 100)
    $pnlBody.Size     = New-Object System.Drawing.Size(520, 470)
    $pnlBody.BackColor = $C.BgPanel
    $frm.Controls.Add($pnlBody)

    $y = 15
    $lw = 440
    $lx = 40

    $pnlBody.Controls.Add((New-Label 'Cloud Server URL' $lx $y $lw 18 $F.Small $C.TextSec))
    $y += 22
    $txtUrl = New-Txt 'http://localhost:3000' $lx $y $lw
    $pnlBody.Controls.Add($txtUrl)

    $y += 40
    $pnlBody.Controls.Add((New-Label 'Shop Name (e.g. Metro Cyber Cafe)' $lx $y $lw 18 $F.Small $C.TextSec))
    $y += 22
    $txtShopName = New-Txt '' $lx $y $lw
    $pnlBody.Controls.Add($txtShopName)

    $y += 40
    $pnlBody.Controls.Add((New-Label 'Owner Email' $lx $y $lw 18 $F.Small $C.TextSec))
    $y += 22
    $txtEmail = New-Txt '' $lx $y $lw
    $pnlBody.Controls.Add($txtEmail)

    $y += 40
    $pnlBody.Controls.Add((New-Label 'Shop PIN (4-8 digits)' $lx $y 210 18 $F.Small $C.TextSec))
    $pnlBody.Controls.Add((New-Label 'Confirm PIN' ($lx + 220) $y 220 18 $F.Small $C.TextSec))
    $y += 22
    $txtPin = New-Txt '' $lx $y 210 $true
    $pnlBody.Controls.Add($txtPin)
    $txtPin2 = New-Txt '' ($lx + 220) $y 220 $true
    $pnlBody.Controls.Add($txtPin2)

    $y += 40
    $pnlBody.Controls.Add((New-Label 'Station Name (e.g. Counter 1)' $lx $y $lw 18 $F.Small $C.TextSec))
    $y += 22
    $txtStation = New-Txt 'Main Counter' $lx $y $lw
    $pnlBody.Controls.Add($txtStation)

    $y += 46
    $errLbl = New-Label '' $lx $y $lw 20 $F.Small $C.Red
    $pnlBody.Controls.Add($errLbl)

    $y += 24
    $btnReg = New-Btn 'Register My Shop' $lx $y $lw 42 $C.Blue $null
    $pnlBody.Controls.Add($btnReg)
    $frm.AcceptButton = $btnReg

    $y += 50
    $pnlBody.Controls.Add((New-Label 'Already registered? Connect to existing shop:' $lx $y $lw 18 $F.Small $C.TextDim))
    $y += 22
    $btnExist = New-Btn 'Connect to Existing Shop' $lx $y $lw 32 $C.BgInput $C.TextSec
    $pnlBody.Controls.Add($btnExist)

    # -- Existing shop sub-form (hidden) ------------------------
    $pnlExist = New-Object System.Windows.Forms.Panel
    $pnlExist.Location  = New-Object System.Drawing.Point($lx, ($y + 40))
    $pnlExist.Size      = New-Object System.Drawing.Size($lw, 120)
    $pnlExist.BackColor = $C.BgCard
    $pnlExist.Visible   = $false
    $pnlBody.Controls.Add($pnlExist)

    $pnlExist.Controls.Add((New-Label 'Existing Shop Slug' 10 8 $lw 18 $F.Small $C.TextSec))
    $txtExSlug = New-Txt 'default' 10 28 ($lw - 20)
    $pnlExist.Controls.Add($txtExSlug)
    $pnlExist.Controls.Add((New-Label 'Existing Shop PIN' 10 62 $lw 18 $F.Small $C.TextSec))
    $txtExPin = New-Txt '' 10 82 ($lw - 20) $true
    $pnlExist.Controls.Add($txtExPin)

    $script:wizardResult = $null

    $btnExist.add_Click({
        $pnlExist.Visible = -not $pnlExist.Visible
        if ($pnlExist.Visible) {
            $frm.Height = 690
            $pnlBody.Height = 560
        } else {
            $frm.Height = 600
            $pnlBody.Height = 470
        }
    })

    # -- Register handler ----------------------------------------
    $btnReg.add_Click({
        $errLbl.Text = ''
        $serverUrl   = $txtUrl.Text.Trim().TrimEnd('/')
        $shopName    = $txtShopName.Text.Trim()
        $email       = $txtEmail.Text.Trim()
        $pin         = $txtPin.Text.Trim()
        $pin2        = $txtPin2.Text.Trim()
        $station     = $txtStation.Text.Trim()

        if ($pnlExist.Visible -and $txtExSlug.Text.Trim() -and $txtExPin.Text.Trim()) {
            $slug2 = $txtExSlug.Text.Trim()
            $pin3  = $txtExPin.Text.Trim()
            $btnReg.Text    = 'Connecting...'
            $btnReg.Enabled = $false
            try {
                $body = @{ shopSlug = $slug2; pin = $pin3; agentName = $station }
                $data = Invoke-Api 'POST' "$serverUrl/api/auth/agent/self-register" $body
                $cfg = [PSCustomObject]@{
                    serverUrl   = $serverUrl
                    agentToken  = $data.agentToken
                    agentId     = $data.agentId
                    agentName   = $data.agentName
                    shopId      = $data.shopId
                    shopName    = $data.shopName
                    shopSlug    = $slug2
                    ownerEmail  = ''
                    isNew       = $false
                }
                Save-Config $cfg
                $script:wizardResult = $cfg
                $frm.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $frm.Close()
            } catch {
                $msg = $_.Exception.Message
                try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
                $errLbl.Text    = "Error: $msg"
                $btnReg.Text    = 'Register My Shop'
                $btnReg.Enabled = $true
            }
            return
        }

        # Validate new registration
        if (-not $serverUrl) { $errLbl.Text = 'Server URL is required.'; return }
        if (-not $shopName)  { $errLbl.Text = 'Shop name is required.';  return }
        if (-not $email -or $email -notmatch '@') { $errLbl.Text = 'Valid email required.'; return }
        if (-not $pin -or $pin -notmatch '^\d{4,8}$') { $errLbl.Text = 'PIN must be 4-8 digits.'; return }
        if ($pin -ne $pin2)  { $errLbl.Text = 'PINs do not match.';       return }
        if (-not $station)   { $errLbl.Text = 'Station name is required.'; return }

        $btnReg.Text    = 'Registering...'
        $btnReg.Enabled = $false
        try {
            $body = @{ shopName = $shopName; ownerEmail = $email; pin = $pin; stationName = $station }
            $data = Invoke-Api 'POST' "$serverUrl/api/auth/vendor/register" $body
            $cfg = [PSCustomObject]@{
                serverUrl   = $serverUrl
                agentToken  = $data.agentToken
                agentId     = $data.agentId
                agentName   = $data.stationName
                shopId      = $data.shopId
                shopName    = $data.shopName
                shopSlug    = $data.shopSlug
                ownerEmail  = $data.ownerEmail
                isNew       = $true
                autoPrint   = $true
                soundAlert  = $true
            }
            Save-Config $cfg
            $script:wizardResult = $cfg
            # Close wizard immediately so dashboard launches
            $frm.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $frm.Close()
        } catch {
            $msg = $_.Exception.Message
            try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
            $errLbl.Text    = "Error: $msg"
            $btnReg.Text    = 'Register My Shop'
            $btnReg.Enabled = $true
        }
    })

    $frm.ShowDialog() | Out-Null
    return $script:wizardResult
}

# ================================================================
#   STEP 2 - MAIN DASHBOARD WINDOW
# ================================================================
function Build-VendorDashboard([PSCustomObject]$cfg) {
    # Store cfg in script scope so all script: functions can access it
    $script:cfg = $cfg
    if ($null -eq $cfg.autoPrint)  { $cfg | Add-Member -NotePropertyName 'autoPrint' -NotePropertyValue $true -Force }
    if ($null -eq $cfg.soundAlert) { $cfg | Add-Member -NotePropertyName 'soundAlert' -NotePropertyValue $true -Force }
    $script:autoPrint   = [bool]$cfg.autoPrint
    $script:soundAlert  = [bool]$cfg.soundAlert
    if ($null -eq $cfg.autoEnhance) { $cfg | Add-Member -NotePropertyName 'autoEnhance' -NotePropertyValue $true -Force }
    $script:autoEnhance = [bool]$cfg.autoEnhance

    $win = New-Object System.Windows.Forms.Form
    $win.Text            = "QrPrintDesk - $($cfg.shopName)"
    $win.Size            = New-Object System.Drawing.Size(1100, 700)
    $win.MinimumSize     = New-Object System.Drawing.Size(900, 600)
    $win.StartPosition   = 'CenterScreen'
    $win.BackColor       = $C.BgDeep
    $win.ForeColor       = $C.TextPri
    $win.Font            = $F.Body
    $win.WindowState     = 'Normal'

    # -- Content area (Dock = Fill) ------------------------------
    $content = New-Object System.Windows.Forms.Panel
    $content.Dock      = 'Fill'
    $content.BackColor = $C.BgPanel

    # -- Left sidebar (Dock = Left) ------------------------------
    $sidebar = New-Object System.Windows.Forms.Panel
    $sidebar.Dock      = 'Left'
    $sidebar.Width     = 200
    $sidebar.BackColor = $C.BgDeep

    $sLogo = New-Label 'QrPrintDesk' 16 14 168 28 $F.Heading $C.Accent
    $sidebar.Controls.Add($sLogo)
    $sShop = New-Label $cfg.shopName 16 42 168 18 $F.Small $C.TextDim
    $sidebar.Controls.Add($sShop)

    # Interactive Print Mode Toggle Button
    $btnModeToggle = New-Object System.Windows.Forms.Button
    $btnModeToggle.Location = New-Object System.Drawing.Point(12, 66)
    $btnModeToggle.Size     = New-Object System.Drawing.Size(176, 32)
    $btnModeToggle.FlatStyle = 'Flat'
    $btnModeToggle.FlatAppearance.BorderSize = 0
    $btnModeToggle.Font     = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
    $btnModeToggle.Cursor   = [System.Windows.Forms.Cursors]::Hand
    $sidebar.Controls.Add($btnModeToggle)
    $script:btnModeToggle = $btnModeToggle

    $navItems = @(
        @{ Key='Dashboard';  Text='[=] Dashboard';  Y=108 },
        @{ Key='QRCode';     Text='[#] QR Code';    Y=150 },
        @{ Key='PrintJobs';  Text='[*] Print Jobs'; Y=192 },
        @{ Key='Settings';   Text='[!] Settings';   Y=234 },
        @{ Key='Connection'; Text='[o] Connection'; Y=276 }
    )
    $navBtns = @{}
    foreach ($ni in $navItems) {
        $nb = New-Object System.Windows.Forms.Button
        $nb.Text      = $ni.Text
        $nb.Location  = New-Object System.Drawing.Point(0, $ni.Y)
        $nb.Size      = New-Object System.Drawing.Size(200, 38)
        $nb.FlatStyle = 'Flat'
        $nb.FlatAppearance.BorderSize = 0
        $nb.TextAlign = 'MiddleLeft'
        $nb.Padding   = New-Object System.Windows.Forms.Padding(16, 0, 0, 0)
        $nb.ForeColor = $C.TextSec
        $nb.BackColor = $C.BgDeep
        $nb.Font      = $F.Body
        $nb.Cursor    = [System.Windows.Forms.Cursors]::Hand
        $sidebar.Controls.Add($nb)
        $navBtns[$ni.Key] = $nb
    }

    $sep = New-Object System.Windows.Forms.Panel
    $sep.Location  = New-Object System.Drawing.Point(0, 326)
    $sep.Size      = New-Object System.Drawing.Size(200, 1)
    $sep.BackColor = $C.Border
    $sidebar.Controls.Add($sep)

    $sWsLabel = New-Label 'Offline' 16 338 168 20 $F.Small $C.TextDim
    $sidebar.Controls.Add($sWsLabel)

    $sVer = New-Label 'QrPrintDesk v1.2' 16 360 168 18 $F.Small $C.TextDim
    $sidebar.Controls.Add($sVer)

    # Add content FIRST, sidebar SECOND, and arrange z-order
    $win.Controls.Add($content)
    $win.Controls.Add($sidebar)
    $sidebar.SendToBack()
    $content.BringToFront()

    $pages = @{}

    # These must be script-scope so WinForms event handlers can call them
    function script:Switch-Page([string]$pageKey) {
        foreach ($k in $script:pages.Keys) {
            if ($k -eq $pageKey) {
                $script:pages[$k].Visible = $true
                $script:pages[$k].BringToFront()
            } else {
                $script:pages[$k].Visible = $false
            }
        }
        foreach ($k in $script:navBtns.Keys) {
            if ($k -eq $pageKey) {
                $script:navBtns[$k].ForeColor = $script:C.Accent
                $script:navBtns[$k].BackColor = [System.Drawing.Color]::FromArgb(35, 59, 130, 246)
            } else {
                $script:navBtns[$k].ForeColor = $script:C.TextSec
                $script:navBtns[$k].BackColor = $script:C.BgDeep
            }
        }

        # Auto-load or refresh data for the active page
        if ($pageKey -eq 'QRCode') {
            if ($null -eq $script:qrBox -or $null -eq $script:qrBox.Image) {
                try { script:Load-QR } catch {}
            }
        } elseif ($pageKey -eq 'PrintJobs') {
            try { script:Refresh-Jobs } catch {}
        } elseif ($pageKey -eq 'Dashboard') {
            try { script:Refresh-Dashboard } catch {}
        }
    }

    foreach ($ni in $navItems) {
        $p = New-Object System.Windows.Forms.Panel
        $p.Dock      = 'Fill'
        $p.BackColor = $C.BgPanel
        $p.Visible   = $false
        $content.Controls.Add($p)
        $pages[$ni.Key] = $p

        $nb = $navBtns[$ni.Key]
        $nb.Tag = $ni.Key
        $nb.add_Click({ script:Switch-Page $this.Tag })
    }
    $script:pages   = $pages
    $script:navBtns = $navBtns

    # ------------------------------------------------
    #  PAGE: Dashboard
    # ------------------------------------------------
    $pgDash = $pages['Dashboard']
    $pgDash.Controls.Add((New-Label 'Vendor Dashboard' 30 24 500 28 $F.Heading $C.TextPri))
    $pgDash.Controls.Add((New-Label "Today overview for $($cfg.shopName)" 30 54 500 18 $F.Small $C.TextDim))

    $sc1 = New-StatCard $pgDash  30  90 "Today Orders"   '0' $C.Blue   'Total Orders: -'
    $sc2 = New-StatCard $pgDash 235  90 'Jobs Pending'   '0' $C.Amber  'Live Queue'
    $sc3 = New-StatCard $pgDash 440  90 'Completed Today' '0' $C.Green  'Printed today'
    $sc4 = New-StatCard $pgDash 645  90 'Revenue Today'  'Rs. 0.00' $C.Accent 'Total Rev: -'

    $pgDash.Controls.Add((New-Label 'Recent Print Jobs' 30 200 700 20 $F.Heading $C.TextPri))

    $jobsGrid = New-Object System.Windows.Forms.DataGridView
    $jobsGrid.Location             = New-Object System.Drawing.Point(30, 228)
    $jobsGrid.Size                 = New-Object System.Drawing.Size(820, 350)
    $jobsGrid.BackgroundColor      = $C.BgCard
    $jobsGrid.GridColor            = $C.Border
    $jobsGrid.ForeColor            = $C.TextPri
    $jobsGrid.DefaultCellStyle.BackColor   = $C.BgCard
    $jobsGrid.DefaultCellStyle.ForeColor   = $C.TextPri
    $jobsGrid.DefaultCellStyle.Font        = $F.Small
    $jobsGrid.DefaultCellStyle.SelectionBackColor = $C.BlueHov
    $jobsGrid.ColumnHeadersDefaultCellStyle.BackColor = $C.BgDeep
    $jobsGrid.ColumnHeadersDefaultCellStyle.ForeColor = $C.TextSec
    $jobsGrid.ColumnHeadersDefaultCellStyle.Font = $F.Small
    $jobsGrid.ColumnHeadersHeightSizeMode  = 'DisableResizing'
    $jobsGrid.ColumnHeadersHeight          = 30
    $jobsGrid.RowHeadersVisible            = $false
    $jobsGrid.ReadOnly                     = $true
    $jobsGrid.AutoSizeColumnsMode          = 'Fill'
    $jobsGrid.AllowUserToAddRows           = $false
    $jobsGrid.AllowUserToDeleteRows        = $false
    $jobsGrid.SelectionMode                = 'FullRowSelect'
    $jobsGrid.BorderStyle                  = 'None'

    $cols = @('Job ID','Order ID','Customer','Color','Copies','Amount','Status','Time')
    foreach ($colName in $cols) {
        $gridCol = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
        $gridCol.Name       = $colName
        $gridCol.HeaderText = $colName
        $gridCol.SortMode   = 'NotSortable'
        $jobsGrid.Columns.Add($gridCol) | Out-Null
    }
    $pgDash.Controls.Add($jobsGrid)

    $btnPrintSelDash = New-Btn 'Print Selected' 30 588 150 34 $C.Green $null
    $pgDash.Controls.Add($btnPrintSelDash)

    $btnPrevSelDash  = New-Btn 'Preview' 190 588 110 34 $C.Blue $null
    $pgDash.Controls.Add($btnPrevSelDash)

    $btnRefreshDash = New-Btn 'Refresh' 310 588 100 34 $C.BgInput $C.TextSec
    $pgDash.Controls.Add($btnRefreshDash)

    $lblDashHint = New-Label 'Select any row to Print or Preview. Auto-Print or Semi-Auto can be toggled on the sidebar.' 425 596 420 20 $F.Small $C.TextDim
    $pgDash.Controls.Add($lblDashHint)

    $script:sc1 = $sc1; $script:sc2 = $sc2; $script:sc3 = $sc3; $script:sc4 = $sc4
    $script:jobsGrid = $jobsGrid
    $script:dashBusy = $false   # guard: don't double-queue

    # Mode switcher logic
    function script:Update-ModeUI {
        if ($script:autoPrint) {
            $script:btnModeToggle.Text      = 'Auto-Print: ON'
            $script:btnModeToggle.BackColor = [System.Drawing.Color]::FromArgb(22, 101, 52)
            $script:btnModeToggle.ForeColor = [System.Drawing.Color]::White
            if ($script:rbAuto) { $script:rbAuto.Checked = $true }
        } else {
            $script:btnModeToggle.Text      = 'Semi-Auto: ON'
            $script:btnModeToggle.BackColor = [System.Drawing.Color]::FromArgb(180, 83, 9)
            $script:btnModeToggle.ForeColor = [System.Drawing.Color]::White
            if ($script:rbSemi) { $script:rbSemi.Checked = $true }
        }
    }

    function script:Toggle-PrintMode {
        $script:autoPrint = -not $script:autoPrint
        $script:cfg | Add-Member -NotePropertyName 'autoPrint' -NotePropertyValue $script:autoPrint -Force
        Save-Config $script:cfg
        script:Update-ModeUI
        $modeDesc = if ($script:autoPrint) { 'Auto-Print is ON: incoming orders print immediately.' } else { 'Semi-Auto is ON: incoming orders hold for manual approval.' }
        try { $tray.ShowBalloonTip(2000, 'Print Mode Changed', $modeDesc, 'Info') } catch {}
    }
    $btnModeToggle.add_Click({ script:Toggle-PrintMode })
    script:Update-ModeUI

    # Async helper â€” runs $apiBlock in a background runspace, polls via a UI timer,
    # then calls $uiBlock on the UI thread (timer ticks are already on the UI thread).
    function script:Invoke-Async([scriptblock]$apiBlock, [scriptblock]$uiBlock, [hashtable]$vars = $null) {
        $rs  = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $rs.ApartmentState = 'MTA'; $rs.Open()
        # Pass standard runtime variables into the runspace
        $rs.SessionStateProxy.SetVariable('_url',        $script:cfg.serverUrl)
        $rs.SessionStateProxy.SetVariable('_token',      $script:cfg.agentToken)
        $rs.SessionStateProxy.SetVariable('_slug',       $script:cfg.shopSlug)
        $rs.SessionStateProxy.SetVariable('_tmpDir',     $TmpDir)
        $rs.SessionStateProxy.SetVariable('_sumatraExe', $SumatraExe)
        $pName = if ($script:cfg.printerName) { $script:cfg.printerName } else { '' }
        $rs.SessionStateProxy.SetVariable('_printerName', $pName)
        $rs.SessionStateProxy.SetVariable('_autoEnhance', [bool]$script:autoEnhance)
        $rs.SessionStateProxy.SetVariable('_enhanceCode', $script:EnhanceDocCode)

        if ($vars) {
            foreach ($k in $vars.Keys) {
                $rs.SessionStateProxy.SetVariable($k, $vars[$k])
            }
        }

        $ps  = [System.Management.Automation.PowerShell]::Create()
        $ps.Runspace = $rs
        $ps.AddScript($apiBlock) | Out-Null
        $handle = $ps.BeginInvoke()

        # Poll every 120 ms on the UI thread
        $t = New-Object System.Windows.Forms.Timer; $t.Interval = 120
        $psCap = $ps; $rsCap = $rs; $hCap = $handle; $uiCap = $uiBlock
        $t.add_Tick({
            if (-not $hCap.IsCompleted) { return }
            $t.Stop(); $t.Dispose()
            try {
                $result = $psCap.EndInvoke($hCap)
                if ($uiCap) {
                    if ($result -and $result.Count -gt 0) { & $uiCap $result[0] } else { & $uiCap $null }
                }
            } catch {
                Write-Log 'WARN' "Async result: $($_.Exception.Message)"
                if ($uiCap) { & $uiCap $null }
            } finally {
                try { $psCap.Dispose() } catch {}
                try { $rsCap.Close()   } catch {}
            }
        })
        $t.Start()
    }

    function script:Print-SelectedJob($grid, $btn) {
        if (-not $grid.SelectedRows -or $grid.SelectedRows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Please select a job from the table first.', 'No Job Selected', 0, 48) | Out-Null
            return
        }
        $row = $grid.SelectedRows[0]
        $jobId = [string]$row.Tag
        if (-not $jobId) { return }

        $cust = [string]$row.Cells['Customer'].Value
        $copies = [string]$row.Cells['Copies'].Value
        $color = [string]$row.Cells['Color'].Value

        $confirm = [System.Windows.Forms.MessageBox]::Show(
            "Send this job to printer now?`n`nCustomer: $cust`nCopies: $copies`nColor: $color",
            'Confirm Print Job',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) { return }

        $origText = $btn.Text
        $btn.Enabled = $false
        $btn.Text = 'Printing...'

        script:Invoke-Async `
        -vars @{ _jid = $jobId } `
        -apiBlock {
            try {
                $h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $_token" }
                $p = @{ Method='GET'; Uri="$_url/api/agent/jobs/$_jid/download-url"; Headers=$h; UseBasicParsing=$true; TimeoutSec=25; ErrorAction='Stop' }
                $meta = (Invoke-WebRequest @p).Content | ConvertFrom-Json

                $printer = if ($_printerName) { $_printerName } elseif ($meta.printOptions.printerName) { $meta.printOptions.printerName } else { '' }
                $copies  = if ($meta.printOptions.copies -and [int]$meta.printOptions.copies -gt 1) { [int]$meta.printOptions.copies } else { 1 }
                $paper   = if ($meta.printOptions.paperSize) { $meta.printOptions.paperSize } else { 'A4' }
                $parts   = @('fit', "paper=$paper")
                if ($meta.printOptions.orientation -eq 'landscape')  { $parts += 'landscape' }
                elseif ($meta.printOptions.orientation -eq 'portrait') { $parts += 'portrait' }
                if ($meta.printOptions.duplexMode -eq 'duplexlong')  { $parts += 'duplex' }
                if ($meta.printOptions.duplexMode -eq 'duplexshort') { $parts += 'duplexshort' }
                if ($copies -gt 1)                                   { $parts += "${copies}x" }
                $settings = $parts -join ','

                $allOk = $true
                foreach ($file in $meta.files) {
                    $ext = [System.IO.Path]::GetExtension($file.originalFilename)
                    if (-not $ext) { $ext = '.pdf' }
                    $tmp = "$_tmpDir\$_jid$ext"

                    $wc = New-Object System.Net.WebClient
                    $wc.DownloadFile($file.downloadUrl, $tmp)
                    $wc.Dispose()

                    $printTarget = $tmp
                    $enhancedTmp = "$_tmpDir\enhanced_$_jid.jpg"
                    if ($_autoEnhance -and ($ext -match '^\.(jpe?g|png|bmp|jfif|webp|tiff?)$')) {
                        try {
                            if (-not (Get-Command Enhance-DocumentImage -ErrorAction SilentlyContinue)) {
                                . ([scriptblock]::Create($_enhanceCode))
                            }
                            $colorMode = if ($meta.printOptions.colorMode) { $meta.printOptions.colorMode } else { 'monochrome' }
                            $enhanced = Enhance-DocumentImage $tmp $enhancedTmp $colorMode
                            if ($enhanced -and (Test-Path $enhancedTmp)) {
                                $printTarget = $enhancedTmp
                            }
                        } catch {}
                    }

                    $pArgs = @('-print-settings', $settings, '-silent', '-exit-when-done')
                    if ($printer) { $pArgs = @('-print-to', "`"$printer`"") + $pArgs } else { $pArgs = @('-print-to-default') + $pArgs }
                    $pArgs += "`"$printTarget`""

                    $proc = Start-Process -FilePath $_sumatraExe -ArgumentList $pArgs -Wait -PassThru -WindowStyle Hidden
                    if ($proc.ExitCode -ne 0) { $allOk = $false }
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                    Remove-Item $enhancedTmp -Force -ErrorAction SilentlyContinue
                }

                $outcome = if ($allOk) { 'SUCCESS' } else { 'UNCERTAIN' }
                $opId    = [System.Guid]::NewGuid().ToString()
                $statBody = @{ outcome = $outcome; opId = $opId } | ConvertTo-Json -Compress
                Invoke-WebRequest -Method POST -Uri "$_url/api/agent/jobs/$_jid/status" -Headers $h -Body $statBody -UseBasicParsing -TimeoutSec 15 | Out-Null

                [PSCustomObject]@{ success = $allOk; jobId = $_jid; outcome = $outcome }
            } catch {
                [PSCustomObject]@{ success = $false; jobId = $_jid; error = $_.Exception.Message }
            }
        } `
        -uiBlock {
            param($res)
            $btn.Enabled = $true
            $btn.Text = $origText
            if (-not $res) { return }
            if ($res.success) {
                $script:jobCount++
                $script:sessionJobsLbl.Text = $script:jobCount.ToString()
                if ($script:soundAlert) {
                    try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
                }
                [System.Windows.Forms.MessageBox]::Show("Job sent to printer successfully!", 'Print Complete', 0, 64) | Out-Null
            } else {
                $errMsg = if ($res.error) { $res.error } else { "Outcome: $($res.outcome)" }
                [System.Windows.Forms.MessageBox]::Show("Printing failed: $errMsg", 'Print Error', 0, 48) | Out-Null
            }
            script:Refresh-Dashboard
            script:Refresh-Jobs
        }
    }

    function script:Preview-SelectedJob($grid, $btn) {
        if (-not $grid.SelectedRows -or $grid.SelectedRows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Please select a job from the table first.', 'No Job Selected', 0, 48) | Out-Null
            return
        }
        $row = $grid.SelectedRows[0]
        $jobId = [string]$row.Tag
        if (-not $jobId) { return }

        $origText = $btn.Text
        $btn.Enabled = $false
        $btn.Text = 'Opening...'

        script:Invoke-Async `
        -vars @{ _jid = $jobId } `
        -apiBlock {
            try {
                $h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $_token" }
                $p = @{ Method='GET'; Uri="$_url/api/agent/jobs/$_jid/download-url"; Headers=$h; UseBasicParsing=$true; TimeoutSec=25; ErrorAction='Stop' }
                $meta = (Invoke-WebRequest @p).Content | ConvertFrom-Json

                if (-not $meta.files -or $meta.files.Count -eq 0) {
                    return [PSCustomObject]@{ success = $false; error = 'No files found in this job' }
                }
                $file = $meta.files[0]
                $ext = [System.IO.Path]::GetExtension($file.originalFilename)
                if (-not $ext) { $ext = '.pdf' }
                $tmp = "$_tmpDir\preview_$_jid$ext"

                $wc = New-Object System.Net.WebClient
                $wc.DownloadFile($file.downloadUrl, $tmp)
                $wc.Dispose()

                $previewTarget = $tmp
                if ($_autoEnhance -and ($ext -match '^\.(jpe?g|png|bmp|jfif|webp|tiff?)$')) {
                    try {
                        if (-not (Get-Command Enhance-DocumentImage -ErrorAction SilentlyContinue)) {
                            . ([scriptblock]::Create($_enhanceCode))
                        }
                        $colorMode = if ($meta.printOptions.colorMode) { $meta.printOptions.colorMode } else { 'monochrome' }
                        $enhancedTmp = "$_tmpDir\preview_enhanced_$_jid.jpg"
                        $enhanced = Enhance-DocumentImage $tmp $enhancedTmp $colorMode
                        if ($enhanced -and (Test-Path $enhancedTmp)) {
                            $previewTarget = $enhancedTmp
                        }
                    } catch {}
                }

                [PSCustomObject]@{ success = $true; filePath = $previewTarget; filename = $file.originalFilename }
            } catch {
                [PSCustomObject]@{ success = $false; error = $_.Exception.Message }
            }
        } `
        -uiBlock {
            param($res)
            $btn.Enabled = $true
            $btn.Text = $origText
            if (-not $res) { return }
            if ($res.success -and (Test-Path $res.filePath)) {
                Start-Process -FilePath $SumatraExe -ArgumentList "`"$($res.filePath)`""
            } else {
                [System.Windows.Forms.MessageBox]::Show("Could not preview document: $($res.error)", 'Preview Error', 0, 48) | Out-Null
            }
        }
    }

    $btnPrintSelDash.add_Click({ script:Print-SelectedJob $script:jobsGrid $this })
    $btnPrevSelDash.add_Click({ script:Preview-SelectedJob $script:jobsGrid $this })

    function script:Refresh-Dashboard {
        if ($script:dashBusy) { return }
        $script:dashBusy = $true
        script:Invoke-Async `
        -apiBlock {
            $h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $_token" }
            $p = @{ UseBasicParsing=$true; Headers=$h; TimeoutSec=12; ErrorAction='Stop' }
            $dashJson = (Invoke-WebRequest @p -Method GET -Uri "$_url/api/vendor/dashboard").Content
            $jobsJson = (Invoke-WebRequest @p -Method GET -Uri "$_url/api/vendor/jobs?limit=30").Content
            [PSCustomObject]@{ dashJson=$dashJson; jobsJson=$jobsJson }
        } `
        -uiBlock {
            param($r)
            $script:dashBusy = $false
            if (-not $r -or -not $r.dashJson) { return }
            try {
                $d = $r.dashJson | ConvertFrom-Json
                $jobsData = if ($r.jobsJson) { $r.jobsJson | ConvertFrom-Json } else { $null }
                $script:dashData = $d

                $pending   = if ($d.stats -and $d.stats.pendingJobs)        { [int]$d.stats.pendingJobs }        else { 0 }
                $todayOrd  = if ($d.stats -and $d.stats.todayOrders)        { [int]$d.stats.todayOrders }        else { 0 }
                $totalOrd  = if ($d.stats -and $d.stats.totalOrders)        { [int]$d.stats.totalOrders }        else { 0 }
                $compToday = if ($d.stats -and $d.stats.completedTodayJobs) { [int]$d.stats.completedTodayJobs } else { 0 }
                $revToday  = if ($d.stats -and $d.stats.revenueTodayRupees) { $d.stats.revenueTodayRupees }      else { '0.00' }
                $revTotal  = if ($d.stats -and $d.stats.totalRevenueRupees) { $d.stats.totalRevenueRupees }      else { $revToday }

                $script:pendingJobs = $pending
                $script:sc1.valLabel.Text = "$todayOrd"
                if ($script:sc1.subLabel) { $script:sc1.subLabel.Text = "Total Orders: $totalOrd" }

                $script:sc2.valLabel.Text = "$pending"
                if ($script:sc2.subLabel) { $script:sc2.subLabel.Text = if ($pending -gt 0) { "Needs Attention" } else { "Queue Clear" } }

                $script:sc3.valLabel.Text = "$compToday"
                if ($script:sc3.subLabel) { $script:sc3.subLabel.Text = "Printed Today" }

                $script:sc4.valLabel.Text = "Rs. $revToday"
                if ($script:sc4.subLabel) { $script:sc4.subLabel.Text = "Total Rev: Rs. $revTotal" }

                $script:jobsGrid.Rows.Clear()
                if ($jobsData -and $jobsData.jobs) {
                    foreach ($j in $jobsData.jobs) {
                        try {
                            $amt    = if ($j.order -and $j.order.amountRupees) { "Rs. $($j.order.amountRupees)" } else { '-' }
                            $cust   = if ($j.order -and $j.order.customerName) { $j.order.customerName } else { 'Anonymous' }
                            $color  = if ($j.order -and $j.order.colorMode)    { $j.order.colorMode } else { '-' }
                            $copies = if ($j.order -and $j.order.copies)       { $j.order.copies.ToString() } else { '-' }
                            $time   = if ($j.createdAt) { ([datetime]$j.createdAt).ToString('HH:mm dd/MM') } else { '-' }
                            $jid    = if ($j.jobId   -and $j.jobId.Length   -ge 8) { $j.jobId.Substring(0,8)   } else { [string]$j.jobId }
                            $oid    = if ($j.orderId -and $j.orderId.Length -ge 8) { $j.orderId.Substring(0,8) } else { [string]$j.orderId }
                            $idx    = $script:jobsGrid.Rows.Add($jid, $oid, $cust, $color, $copies, $amt, $j.status, $time)
                            $script:jobsGrid.Rows[$idx].Tag = $j.jobId
                            $cell   = $script:jobsGrid.Rows[$idx].Cells['Status']
                            switch ($j.status) {
                                'COMPLETED'       { $cell.Style.ForeColor = $script:C.Green  }
                                'FAILED'          { $cell.Style.ForeColor = $script:C.Red    }
                                'QUEUED'          { $cell.Style.ForeColor = $script:C.Amber  }
                                'PRINT_SUBMITTED' { $cell.Style.ForeColor = $script:C.Blue   }
                                default           { $cell.Style.ForeColor = $script:C.TextSec }
                            }
                        } catch {}
                    }
                }
            } catch {
                Write-Log 'WARN' "Dashboard UI render error: $($_.Exception.Message)"
            }
        }
    }
    $btnRefreshDash.add_Click({ script:Refresh-Dashboard })

    # ------------------------------------------------
    #  PAGE: QR Code
    # ------------------------------------------------
    $pgQR = $pages['QRCode']
    $pgQR.Controls.Add((New-Label 'Customer QR Code' 30 24 600 28 $F.Heading $C.TextPri))
    $pgQR.Controls.Add((New-Label 'Place this QR code on your desk. Customers scan it with their phone camera to print.' 30 54 700 18 $F.Small $C.TextDim))

    $qrBox = New-Object System.Windows.Forms.PictureBox
    $qrBox.Location    = New-Object System.Drawing.Point(30, 90)
    $qrBox.Size        = New-Object System.Drawing.Size(280, 280)
    $qrBox.SizeMode    = 'Zoom'
    $qrBox.BackColor   = [System.Drawing.Color]::White
    $qrBox.BorderStyle = 'FixedSingle'
    $pgQR.Controls.Add($qrBox)

    $qrStatusLbl = New-Label 'Loading QR Code...' 30 380 280 22 $F.Small $C.TextDim
    $pgQR.Controls.Add($qrStatusLbl)

    # Immediately preload cached QR if available so vendor never sees blank
    $cachedQR = "$TmpDir\shop_qr.png"
    if (Test-Path $cachedQR) {
        try {
            $b = [System.IO.File]::ReadAllBytes($cachedQR)
            $m = New-Object System.IO.MemoryStream(,$b)
            $r = [System.Drawing.Image]::FromStream($m)
            $qrBox.Image = New-Object System.Drawing.Bitmap($r)
            $r.Dispose(); $m.Dispose()
            $qrStatusLbl.ForeColor = $C.Green
            $qrStatusLbl.Text = 'QR Code Ready for Scanning'
        } catch {}
    }

    $qrLinkLabel = New-Label 'Customer Web Link:' 330 90 600 18 $F.Small $C.TextDim
    $pgQR.Controls.Add($qrLinkLabel)
    $qrLinkBox = New-Object System.Windows.Forms.TextBox
    $qrLinkBox.Location    = New-Object System.Drawing.Point(330, 112)
    $qrLinkBox.Size        = New-Object System.Drawing.Size(500, 28)
    $qrLinkBox.BackColor   = $C.BgInput
    $qrLinkBox.ForeColor   = $C.Accent
    $qrLinkBox.BorderStyle = 'FixedSingle'
    $qrLinkBox.Font        = $F.Mono
    $qrLinkBox.ReadOnly    = $true
    if ($cfg.serverUrl -and $cfg.shopSlug) {
        $qrLinkBox.Text = "$($cfg.serverUrl)/shop/$($cfg.shopSlug)"
    }
    $pgQR.Controls.Add($qrLinkBox)

    $pgQR.Controls.Add((New-Label 'Current Pricing:' 330 158 400 18 $F.Small $C.TextDim))
    $qrPriceLabel = New-Label '' 330 178 500 60 $F.Body $C.TextSec
    $pgQR.Controls.Add($qrPriceLabel)

    $btnLoadQR = New-Btn 'Reload QR' 330 260 140 36 $C.Blue $null
    $pgQR.Controls.Add($btnLoadQR)

    $btnPrintQR = New-Btn 'Print QR Poster' 480 260 150 36 $C.BgInput $C.TextSec
    $pgQR.Controls.Add($btnPrintQR)

    $btnCopyLink = New-Btn 'Copy Link' 640 260 130 36 $C.BgInput $C.TextSec
    $pgQR.Controls.Add($btnCopyLink)

    $btnOpenLink = New-Btn 'Open in Browser' 780 260 150 36 $C.BgInput $C.TextSec
    $pgQR.Controls.Add($btnOpenLink)

    $btnCopyLink.add_Click({
        if ($qrLinkBox.Text) {
            [System.Windows.Forms.Clipboard]::SetText($qrLinkBox.Text)
            [System.Windows.Forms.MessageBox]::Show("Customer link copied to clipboard!`n`n$($qrLinkBox.Text)", 'Link Copied', 0, 64) | Out-Null
        }
    })

    $btnOpenLink.add_Click({
        if ($qrLinkBox.Text) {
            Start-Process $qrLinkBox.Text
        }
    })

    $script:qrBox = $qrBox; $script:qrLinkBox = $qrLinkBox; $script:qrPriceLabel = $qrPriceLabel
    $script:qrStatusLbl = $qrStatusLbl; $script:btnLoadQR = $btnLoadQR

    function script:Load-QR {
        $script:btnLoadQR.Enabled = $false
        $script:btnLoadQR.Text = 'Loading...'
        if (-not $script:qrBox.Image) {
            $script:qrStatusLbl.Text = 'Fetching QR from server...'
            $script:qrStatusLbl.ForeColor = $script:C.TextDim
        }

        script:Invoke-Async `
        -apiBlock {
            $qrPath = ''
            $qrErr = ''
            try {
                $p = @{ UseBasicParsing=$true; TimeoutSec=10; ErrorAction='Stop' }
                $qrRaw = (Invoke-WebRequest @p -Method GET -Uri "$_url/api/shops/$_slug/qr").Content
                $dataUrl = $qrRaw
                try {
                    $j = $qrRaw | ConvertFrom-Json
                    if ($j.qrDataUrl) { $dataUrl = $j.qrDataUrl }
                } catch {}

                $b64 = ''
                if ($dataUrl -and $dataUrl.Contains('base64,')) {
                    $b64 = $dataUrl.Substring($dataUrl.IndexOf('base64,') + 7).Trim()
                } elseif ($dataUrl -match '^data:image/[^;]+;base64,(.+)$') {
                    $b64 = $Matches[1].Trim()
                }

                if ($b64) {
                    $bytes = [Convert]::FromBase64String($b64)
                    $qrPath = "$_tmpDir\shop_qr.png"
                    [System.IO.File]::WriteAllBytes($qrPath, $bytes)
                }
            } catch {
                $qrErr = $_.Exception.Message
            }

            # Fallback to existing disk file if fetch failed
            if (-not $qrPath -and (Test-Path "$_tmpDir\shop_qr.png")) {
                $qrPath = "$_tmpDir\shop_qr.png"
            }

            $infoRaw = $null
            try {
                $p = @{ UseBasicParsing=$true; TimeoutSec=10; ErrorAction='SilentlyContinue' }
                $infoRaw = (Invoke-WebRequest @p -Method GET -Uri "$_url/api/shops/$_slug/info").Content
            } catch {}

            [PSCustomObject]@{
                success = ($qrPath -ne '')
                infoRaw = $infoRaw
                qrPath  = $qrPath
                link    = "$_url/shop/$_slug"
                error   = $qrErr
            }
        } `
        -uiBlock {
            param($r)
            $script:btnLoadQR.Enabled = $true
            $script:btnLoadQR.Text = 'Reload QR'
            if (-not $r) {
                if (-not $script:qrBox.Image) {
                    $script:qrStatusLbl.ForeColor = $script:C.Red
                    $script:qrStatusLbl.Text = 'Failed to load QR. Click Reload QR.'
                }
                return
            }

            if ($r.link) {
                $script:qrLinkBox.Text = $r.link
            }

            $info = $null
            if ($r.infoRaw) {
                try { $info = $r.infoRaw | ConvertFrom-Json } catch {}
            }
            if ($info -and $info.pricing) {
                $bwRs  = [math]::Round($info.pricing.bwPerPagePaise  / 100, 2)
                $colRs = [math]::Round($info.pricing.colorPerPagePaise / 100, 2)
                $script:qrPriceLabel.Text = "B&W Rate: Rs. $bwRs / page`nColor Rate: Rs. $colRs / page"
            }

            if ($r.success -and $r.qrPath -and (Test-Path $r.qrPath)) {
                try {
                    $bytes = [System.IO.File]::ReadAllBytes($r.qrPath)
                    $ms = New-Object System.IO.MemoryStream(,$bytes)
                    $rawImg = [System.Drawing.Image]::FromStream($ms)
                    $oldImg = $script:qrBox.Image
                    $script:qrBox.Image = New-Object System.Drawing.Bitmap($rawImg)
                    $rawImg.Dispose()
                    $ms.Dispose()
                    if ($oldImg) { try { $oldImg.Dispose() } catch {} }
                    $script:qrBox.Refresh()
                    $script:qrStatusLbl.ForeColor = $script:C.Green
                    $script:qrStatusLbl.Text = 'QR Code Ready for Scanning'
                } catch {
                    if (-not $script:qrBox.Image) {
                        $script:qrStatusLbl.ForeColor = $script:C.Red
                        $script:qrStatusLbl.Text = "Render error: $($_.Exception.Message)"
                    }
                }
            } else {
                if (-not $script:qrBox.Image) {
                    $err = if ($r.error) { $r.error } else { 'Could not generate QR' }
                    $script:qrStatusLbl.ForeColor = $script:C.Red
                    $script:qrStatusLbl.Text = "Error: $err"
                }
            }
        }
    }
    $btnLoadQR.add_Click({ script:Load-QR })

    $btnPrintQR.add_Click({
        $qrPath = "$TmpDir\shop_qr.png"
        if (-not (Test-Path $qrPath) -and $qrBox.Image) {
            $qrBox.Image.Save($qrPath)
        }
        if (-not (Test-Path $qrPath)) {
            [System.Windows.Forms.MessageBox]::Show('QR code not loaded yet. Please wait or click Reload QR.', 'Print QR', 0, 48) | Out-Null
            return
        }
        if (-not (Test-Path $SumatraExe)) {
            [System.Windows.Forms.MessageBox]::Show('SumatraPDF not found. Cannot print.','Print',0,48) | Out-Null
            return
        }
        Start-Process -FilePath $SumatraExe -ArgumentList @('-print-to-default','-silent','-exit-when-done', "`"$qrPath`"") -Wait -WindowStyle Hidden
        [System.Windows.Forms.MessageBox]::Show('QR poster sent to printer!', 'Print QR', 0, 64) | Out-Null
    })

    # ------------------------------------------------
    #  PAGE: Print Jobs
    # ------------------------------------------------
    $pgJobs = $pages['PrintJobs']
    $pgJobs.Controls.Add((New-Label 'Print Jobs History' 30 24 500 28 $F.Heading $C.TextPri))

    $pgJobs.Controls.Add((New-Label 'Filter:' 30 60 50 22 $F.Small $C.TextDim))
    $cmbFilter = New-Object System.Windows.Forms.ComboBox
    $cmbFilter.Location = New-Object System.Drawing.Point(80, 56)
    $cmbFilter.Size     = New-Object System.Drawing.Size(160, 26)
    $cmbFilter.BackColor = $C.BgInput
    $cmbFilter.ForeColor = $C.TextPri
    $cmbFilter.FlatStyle = 'Flat'
    $cmbFilter.DropDownStyle = 'DropDownList'
    @('All','QUEUED','PRINT_SUBMITTED','COMPLETED','FAILED','CANCELLED') | ForEach-Object { $cmbFilter.Items.Add($_) | Out-Null }
    $cmbFilter.SelectedIndex = 0
    $pgJobs.Controls.Add($cmbFilter)

    $btnRefreshJobs = New-Btn 'Refresh' 256 54 110 30 $C.BgInput $C.TextSec
    $pgJobs.Controls.Add($btnRefreshJobs)

    $allJobsGrid = New-Object System.Windows.Forms.DataGridView
    $allJobsGrid.Location             = New-Object System.Drawing.Point(30, 96)
    $allJobsGrid.Size                 = New-Object System.Drawing.Size(840, 480)
    $allJobsGrid.BackgroundColor      = $C.BgCard
    $allJobsGrid.GridColor            = $C.Border
    $allJobsGrid.ForeColor            = $C.TextPri
    $allJobsGrid.DefaultCellStyle.BackColor   = $C.BgCard
    $allJobsGrid.DefaultCellStyle.ForeColor   = $C.TextPri
    $allJobsGrid.DefaultCellStyle.Font        = $F.Small
    $allJobsGrid.DefaultCellStyle.SelectionBackColor = $C.BlueHov
    $allJobsGrid.ColumnHeadersDefaultCellStyle.BackColor = $C.BgDeep
    $allJobsGrid.ColumnHeadersDefaultCellStyle.ForeColor = $C.TextSec
    $allJobsGrid.ColumnHeadersDefaultCellStyle.Font      = $F.Small
    $allJobsGrid.ColumnHeadersHeight          = 30
    $allJobsGrid.RowHeadersVisible            = $false
    $allJobsGrid.ReadOnly                     = $true
    $allJobsGrid.AutoSizeColumnsMode          = 'Fill'
    $allJobsGrid.AllowUserToAddRows           = $false
    $allJobsGrid.AllowUserToDeleteRows        = $false
    $allJobsGrid.SelectionMode                = 'FullRowSelect'
    $allJobsGrid.BorderStyle                  = 'None'
    $allJobsGrid.ColumnHeadersHeightSizeMode  = 'DisableResizing'

    $jCols = @('Job ID','Order ID','Status','Retries','Color','Copies','Amount','Customer','Time')
    foreach ($colName in $jCols) {
        $gridCol = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
        $gridCol.Name       = $colName
        $gridCol.HeaderText = $colName
        $gridCol.SortMode   = 'NotSortable'
        $allJobsGrid.Columns.Add($gridCol) | Out-Null
    }
    $pgJobs.Controls.Add($allJobsGrid)

    $btnPrintSelJobs = New-Btn 'Print Selected' 30 588 150 34 $C.Green $null
    $pgJobs.Controls.Add($btnPrintSelJobs)

    $btnPrevSelJobs = New-Btn 'Preview' 190 588 110 34 $C.Blue $null
    $pgJobs.Controls.Add($btnPrevSelJobs)

    $btnRefreshJobs = New-Btn 'Refresh List' 310 588 120 34 $C.BgInput $C.TextSec
    $pgJobs.Controls.Add($btnRefreshJobs)

    $script:allJobsGrid = $allJobsGrid; $script:cmbFilter = $cmbFilter
    $script:jobsBusy = $false
    $script:btnRefreshJobs = $btnRefreshJobs

    function script:Refresh-Jobs {
        if ($script:jobsBusy) { return }
        $script:jobsBusy = $true
        $script:btnRefreshJobs.Enabled = $false
        $filter = if ($script:cmbFilter.SelectedItem) { $script:cmbFilter.SelectedItem.ToString() } else { 'All' }
        $jobsUrl = "$($script:cfg.serverUrl)/api/vendor/jobs?limit=50"
        if ($filter -ne 'All') { $jobsUrl += "&status=$filter" }
        script:Invoke-Async `
        -vars @{ _fetchUrl = $jobsUrl } `
        -apiBlock {
            $h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $_token" }
            $p = @{ UseBasicParsing=$true; Headers=$h; TimeoutSec=12; ErrorAction='Stop' }
            (Invoke-WebRequest @p -Method GET -Uri $_fetchUrl).Content
        } `
        -uiBlock {
            param($rawJson)
            $script:jobsBusy = $false
            $script:btnRefreshJobs.Enabled = $true
            if (-not $rawJson) { return }
            try {
                $jobs = $rawJson | ConvertFrom-Json
                $script:allJobsGrid.Rows.Clear()
                if ($jobs -and $jobs.jobs) {
                    foreach ($j in $jobs.jobs) {
                        try {
                            $amt    = if ($j.order -and $j.order.amountRupees) { "Rs. $($j.order.amountRupees)" } else { '-' }
                            $cust   = if ($j.order -and $j.order.customerName) { $j.order.customerName } else { 'Anon' }
                            $color  = if ($j.order -and $j.order.colorMode)    { $j.order.colorMode } else { '-' }
                            $copies = if ($j.order -and $j.order.copies)       { $j.order.copies.ToString() } else { '-' }
                            $time   = if ($j.createdAt) { ([datetime]$j.createdAt).ToString('HH:mm dd/MM') } else { '-' }
                            $jid    = if ($j.jobId   -and $j.jobId.Length   -ge 8) { $j.jobId.Substring(0,8)   } else { [string]$j.jobId }
                            $oid    = if ($j.orderId -and $j.orderId.Length -ge 8) { $j.orderId.Substring(0,8) } else { [string]$j.orderId }
                            $idx    = $script:allJobsGrid.Rows.Add($jid, $oid, $j.status, [string]$j.retryCount, $color, $copies, $amt, $cust, $time)
                            $script:allJobsGrid.Rows[$idx].Tag = $j.jobId
                            $cell   = $script:allJobsGrid.Rows[$idx].Cells['Status']
                            switch ($j.status) {
                                'COMPLETED'       { $cell.Style.ForeColor = $script:C.Green   }
                                'FAILED'          { $cell.Style.ForeColor = $script:C.Red     }
                                'QUEUED'          { $cell.Style.ForeColor = $script:C.Amber   }
                                'PRINT_SUBMITTED' { $cell.Style.ForeColor = $script:C.Blue    }
                                default           { $cell.Style.ForeColor = $script:C.TextSec }
                            }
                        } catch {}
                    }
                }
            } catch {
                Write-Log 'WARN' "Jobs grid render error: $($_.Exception.Message)"
            }
        }
    }
    $btnRefreshJobs.add_Click({ script:Refresh-Jobs })
    $cmbFilter.add_SelectedIndexChanged({ script:Refresh-Jobs })
    $btnPrintSelJobs.add_Click({ script:Print-SelectedJob $script:allJobsGrid $this })
    $btnPrevSelJobs.add_Click({ script:Preview-SelectedJob $script:allJobsGrid $this })

    # ------------------------------------------------
    #  PAGE: Settings
    # ------------------------------------------------
    $pgSet = $pages['Settings']
    $pgSet.Controls.Add((New-Label 'Shop Settings' 30 24 500 28 $F.Heading $C.TextPri))
    $pgSet.Controls.Add((New-Label 'Configure your shop pricing, automation mode, and printer preferences.' 30 54 700 18 $F.Small $C.TextDim))

    # --- Left Column: Pricing & Shop Info ---
    $pgSet.Controls.Add((New-Label 'Shop Name' 30 100 360 18 $F.Small $C.TextSec))
    $txtSetShopName = New-Txt $cfg.shopName 30 120 360
    $pgSet.Controls.Add($txtSetShopName)

    $pgSet.Controls.Add((New-Label 'B&W Price per Page (in Paise: 100 paise = Rs. 1)' 30 165 360 18 $F.Small $C.TextSec))
    $txtBW = New-Txt '150' 30 185 200
    $pgSet.Controls.Add($txtBW)

    $pgSet.Controls.Add((New-Label 'Color Price per Page (in Paise)' 30 230 360 18 $F.Small $C.TextSec))
    $txtColor = New-Txt '500' 30 250 200
    $pgSet.Controls.Add($txtColor)

    $pgSet.Controls.Add((New-Label 'Duplex Discount per Page (in Paise, 0 = no discount)' 30 295 360 18 $F.Small $C.TextSec))
    $txtDuplex = New-Txt '0' 30 315 200
    $pgSet.Controls.Add($txtDuplex)

    $btnSaveSet = New-Btn 'Save Settings' 30 375 220 40 $C.Blue $null
    $pgSet.Controls.Add($btnSaveSet)

    $setErrLbl = New-Label '' 30 425 400 24 $F.Small $C.Green
    $pgSet.Controls.Add($setErrLbl)

    # --- Right Column: Automation & Hardware ---
    $pgSet.Controls.Add((New-Label 'Print Execution Mode' 450 100 380 18 $F.Small $C.TextSec))

    $rbAuto = New-Object System.Windows.Forms.RadioButton
    $rbAuto.Text      = 'Auto-Print (Prints immediately upon customer payment)'
    $rbAuto.Location  = New-Object System.Drawing.Point(450, 122)
    $rbAuto.Size      = New-Object System.Drawing.Size(400, 24)
    $rbAuto.ForeColor = $C.TextPri
    $rbAuto.Font      = $F.Small
    $rbAuto.Checked   = ($script:autoPrint -ne $false)
    $pgSet.Controls.Add($rbAuto)

    $rbSemi = New-Object System.Windows.Forms.RadioButton
    $rbSemi.Text      = 'Semi-Automated (Hold in queue for vendor manual approval)'
    $rbSemi.Location  = New-Object System.Drawing.Point(450, 150)
    $rbSemi.Size      = New-Object System.Drawing.Size(400, 24)
    $rbSemi.ForeColor = $C.TextPri
    $rbSemi.Font      = $F.Small
    $rbSemi.Checked   = ($script:autoPrint -eq $false)
    $pgSet.Controls.Add($rbSemi)

    $script:rbAuto = $rbAuto
    $script:rbSemi = $rbSemi

    $pgSet.Controls.Add((New-Label 'Smart Document Enhancement' 450 185 380 18 $F.Small $C.TextSec))

    $chkEnhance = New-Object System.Windows.Forms.CheckBox
    $chkEnhance.Text      = 'Auto-enhance document photos (Whiten, sharpen, A4 safe-fit)'
    $chkEnhance.Location  = New-Object System.Drawing.Point(450, 207)
    $chkEnhance.Size      = New-Object System.Drawing.Size(420, 24)
    $chkEnhance.ForeColor = $C.TextPri
    $chkEnhance.Font      = $F.Small
    $chkEnhance.Checked   = ($script:autoEnhance -ne $false)
    $pgSet.Controls.Add($chkEnhance)
    $script:chkEnhance = $chkEnhance

    $pgSet.Controls.Add((New-Label 'Audio & Alerts' 450 242 380 18 $F.Small $C.TextSec))

    $chkSound = New-Object System.Windows.Forms.CheckBox
    $chkSound.Text      = 'Play chime sound when a new customer order arrives'
    $chkSound.Location  = New-Object System.Drawing.Point(450, 264)
    $chkSound.Size      = New-Object System.Drawing.Size(400, 24)
    $chkSound.ForeColor = $C.TextPri
    $chkSound.Font      = $F.Small
    $chkSound.Checked   = ($script:soundAlert -ne $false)
    $pgSet.Controls.Add($chkSound)
    $script:chkSound = $chkSound

    $pgSet.Controls.Add((New-Label 'Default Printer' 450 300 380 18 $F.Small $C.TextSec))

    $cmbPrinter = New-Object System.Windows.Forms.ComboBox
    $cmbPrinter.Location = New-Object System.Drawing.Point(450, 322)
    $cmbPrinter.Size     = New-Object System.Drawing.Size(260, 28)
    $cmbPrinter.BackColor = $C.BgInput
    $cmbPrinter.ForeColor = $C.TextPri
    $cmbPrinter.FlatStyle = 'Flat'
    $cmbPrinter.DropDownStyle = 'DropDownList'
    $cmbPrinter.Items.Add('(System Default)') | Out-Null
    try {
        Get-Printer | Select-Object -ExpandProperty Name | ForEach-Object { $cmbPrinter.Items.Add($_) | Out-Null }
    } catch {}
    $cmbPrinter.SelectedIndex = 0
    $pgSet.Controls.Add($cmbPrinter)
    $script:cmbPrinter = $cmbPrinter

    $btnTestPrint = New-Btn 'Test Print' 720 320 110 32 $C.BgInput $C.TextSec
    $pgSet.Controls.Add($btnTestPrint)

    $lblPrinterNote = New-Label 'Select your preferred receipt/document printer. Click Test Print to test.' 450 358 390 32 $F.Small $C.TextDim
    $pgSet.Controls.Add($lblPrinterNote)

    function script:Print-TestPage($btn) {
        $origText = $btn.Text
        $btn.Enabled = $false
        $btn.Text = 'Printing...'

        script:Invoke-Async `
        -apiBlock {
            try {
                $testFile = "$_tmpDir\test_slip.txt"
                $pName = if ($_printerName) { $_printerName } else { '(Default System Printer)' }
                $lines = @(
                    "========================================",
                    "       QrPrintDesk TEST PRINT SLIP",
                    "========================================",
                    "Shop:    $_slug",
                    "Printer: $pName",
                    "Time:    $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
                    "Status:  System Operational",
                    "========================================",
                    "Your QrPrintDesk station is properly",
                    "configured and ready for live printing!",
                    "========================================"
                )
                Set-Content -Path $testFile -Value ($lines -join "`r`n") -Encoding UTF8
                $proc = Start-Process -FilePath 'notepad.exe' -ArgumentList @('/p', "`"$testFile`"") -Wait -PassThru -WindowStyle Hidden
                [PSCustomObject]@{ success = $true; printer = $pName }
            } catch {
                [PSCustomObject]@{ success = $false; error = $_.Exception.Message }
            }
        } `
        -uiBlock {
            param($res)
            $btn.Enabled = $true
            $btn.Text = $origText
            if ($res -and $res.success) {
                [System.Windows.Forms.MessageBox]::Show("Test print slip sent to: $($res.printer)", 'Test Print Sent', 0, 64) | Out-Null
            } else {
                [System.Windows.Forms.MessageBox]::Show("Test print failed: $($res.error)", 'Print Error', 0, 48) | Out-Null
            }
        }
    }
    $btnTestPrint.add_Click({ script:Print-TestPage $this })

    $script:txtSetShopName = $txtSetShopName; $script:txtBW = $txtBW
    $script:txtColor = $txtColor; $script:txtDuplex = $txtDuplex
    function script:Load-Settings {
        try {
            $data = Invoke-Api 'GET' "$($script:cfg.serverUrl)/api/vendor/dashboard" -token $script:cfg.agentToken
            $script:txtSetShopName.Text = $data.shop.name
            $script:txtBW.Text          = $data.shop.pricing.bwPerPagePaise.ToString()
            $script:txtColor.Text       = $data.shop.pricing.colorPerPagePaise.ToString()
            $script:txtDuplex.Text      = $data.shop.pricing.duplexDiscountPaise.ToString()
            $script:rbAuto.Checked      = ($script:autoPrint -ne $false)
            $script:rbSemi.Checked      = ($script:autoPrint -eq $false)
            $script:chkEnhance.Checked  = ($script:autoEnhance -ne $false)
            $script:chkSound.Checked    = ($script:soundAlert -ne $false)
            if ($script:cfg.printerName) {
                $idx = $script:cmbPrinter.Items.IndexOf($script:cfg.printerName)
                if ($idx -ge 0) { $script:cmbPrinter.SelectedIndex = $idx }
            }
        } catch { Write-Log 'WARN' "Load settings: $($_.Exception.Message)" }
    }

    $script:btnSaveSet = $btnSaveSet; $script:setErrLbl = $setErrLbl
    $btnSaveSet.add_Click({
        $script:setErrLbl.Text = ''
        $script:btnSaveSet.Enabled = $false
        $script:btnSaveSet.Text = 'Saving...'
        try {
            $body = @{
                shopName            = $script:txtSetShopName.Text.Trim()
                bwPerPagePaise      = [int]$script:txtBW.Text
                colorPerPagePaise   = [int]$script:txtColor.Text
                duplexDiscountPaise = [int]$script:txtDuplex.Text
            }
            $res = Invoke-Api 'PUT' "$($script:cfg.serverUrl)/api/vendor/settings" $body -token $script:cfg.agentToken

            $script:autoPrint   = $script:rbAuto.Checked
            $script:soundAlert  = $script:chkSound.Checked
            $script:autoEnhance = $script:chkEnhance.Checked
            $script:cfg | Add-Member -NotePropertyName 'autoPrint'   -NotePropertyValue $script:autoPrint   -Force
            $script:cfg | Add-Member -NotePropertyName 'soundAlert'  -NotePropertyValue $script:soundAlert  -Force
            $script:cfg | Add-Member -NotePropertyName 'autoEnhance' -NotePropertyValue $script:autoEnhance -Force
            if ($script:cmbPrinter.SelectedIndex -gt 0) {
                $script:cfg.printerName = $script:cmbPrinter.SelectedItem.ToString()
            } else {
                $script:cfg.printerName = ''
            }
            $script:cfg.shopName = $res.shop.name
            Save-Config $script:cfg

            script:Update-ModeUI
            $script:setErrLbl.ForeColor = $script:C.Green
            $script:setErrLbl.Text = 'Settings & preferences saved successfully.'
        } catch {
            $msg = $_.Exception.Message
            try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
            $script:setErrLbl.ForeColor = $script:C.Red
            $script:setErrLbl.Text = "Error: $msg"
        } finally {
            $script:btnSaveSet.Enabled = $true
            $script:btnSaveSet.Text = 'Save Settings'
        }
    })

    $script:cmbPrinter = $cmbPrinter
    $cmbPrinter.add_SelectedIndexChanged({
        $sel = $script:cmbPrinter.SelectedItem.ToString()
        if ($sel -ne '(System Default)') {
            $script:cfg | Add-Member -NotePropertyName 'printerName' -NotePropertyValue $sel -Force
        } else {
            $script:cfg | Add-Member -NotePropertyName 'printerName' -NotePropertyValue '' -Force
        }
        Save-Config $script:cfg
    })

    # ------------------------------------------------
    #  PAGE: Connection
    # ------------------------------------------------
    $pgConn = $pages['Connection']
    $pgConn.Controls.Add((New-Label 'Connection Status' 30 24 500 28 $F.Heading $C.TextPri))

    $connStatusLbl = New-Label 'Checking...' 30 70 500 28 $F.Heading $C.TextDim
    $pgConn.Controls.Add($connStatusLbl)

    $pgConn.Controls.Add((New-Label 'Server URL:' 30 120 120 18 $F.Small $C.TextDim))
    $pgConn.Controls.Add((New-Label $cfg.serverUrl 155 120 500 18 $F.Body $C.TextSec))

    $pgConn.Controls.Add((New-Label 'Shop:' 30 146 120 18 $F.Small $C.TextDim))
    $pgConn.Controls.Add((New-Label "$($cfg.shopName) ($($cfg.shopSlug))" 155 146 500 18 $F.Body $C.TextSec))

    $pgConn.Controls.Add((New-Label 'Station:' 30 170 120 18 $F.Small $C.TextDim))
    $pgConn.Controls.Add((New-Label $cfg.agentName 155 170 500 18 $F.Body $C.TextSec))

    $pgConn.Controls.Add((New-Label 'Agent ID:' 30 194 120 18 $F.Small $C.TextDim))
    $pgConn.Controls.Add((New-Label $cfg.agentId 155 194 500 18 $F.Mono $C.TextDim))

    $pgConn.Controls.Add((New-Label 'WebSocket:' 30 228 120 18 $F.Small $C.TextDim))
    $wsConnLbl = New-Label 'Connecting...' 155 228 500 18 $F.Body $C.TextDim
    $pgConn.Controls.Add($wsConnLbl)

    $pgConn.Controls.Add((New-Label 'Jobs this session:' 30 254 150 18 $F.Small $C.TextDim))
    $sessionJobsLbl = New-Label '0' 200 254 200 18 $F.Body $C.TextSec
    $pgConn.Controls.Add($sessionJobsLbl)

    $btnResetReg = New-Btn 'Reset Registration' 30 320 220 36 $C.BgInput $C.Red
    $pgConn.Controls.Add($btnResetReg)
    $pgConn.Controls.Add((New-Label 'Removes saved station credentials. Next launch will open setup wizard.' 265 330 500 18 $F.Small $C.TextDim))

    $btnResetReg.add_Click({
        $confirm = [System.Windows.Forms.MessageBox]::Show(
            "This will remove your saved credentials.`nYou'll need to register again on next launch.",
            'Reset Registration', 'YesNo', 'Warning')
        if ($confirm -eq 'Yes') {
            Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
            [System.Windows.Forms.MessageBox]::Show('Registration reset. Please restart QrPrintDesk.','Done',0,64) | Out-Null
            $win.Close()
        }
    })

    # -- Tray icon ----------------------------------------------
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $bmp = New-Object System.Drawing.Bitmap(32,32)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 0,0,32,32)
    $g.FillEllipse([System.Drawing.Brushes]::White, 6,10,20,12)
    $g.Dispose()
    $tray.Icon    = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $tray.Text    = "QrPrintDesk - $($cfg.shopName)"
    $tray.Visible = $true

    $trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
    $miShow = New-Object System.Windows.Forms.ToolStripMenuItem; $miShow.Text = 'Show Dashboard'
    $miShow.add_Click({
        $win.Show()
        $win.WindowState = 'Normal'
        $win.Activate()
        $win.BringToFront()
    })
    $miExit = New-Object System.Windows.Forms.ToolStripMenuItem; $miExit.Text = 'Exit'
    $miExit.add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
    $trayMenu.Items.AddRange(@($miShow, $miExit))
    $tray.ContextMenuStrip = $trayMenu
    $tray.add_DoubleClick({
        $win.Show()
        $win.WindowState = 'Normal'
        $win.Activate()
        $win.BringToFront()
    })

    $win.add_Resize({
        if ($win.WindowState -eq 'Minimized') {
            $win.Hide()
            $tray.ShowBalloonTip(2000, 'QrPrintDesk', 'Running in background. Double-click tray icon to restore.', 'Info')
        }
    })
    $win.add_FormClosing({
        param($sender, $e)
        if ($e -and $e.CloseReason -eq 'UserClosing') {
            $e.Cancel = $true
            $win.Hide()
            $tray.ShowBalloonTip(2000, 'QrPrintDesk', 'Still running in background. Right-click tray icon to Exit.', 'Info')
        }
    })

    # -- WebSocket background runspace -------------------------
    $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $rs.ApartmentState = 'MTA'
    $rs.ThreadOptions  = 'ReuseThread'
    $rs.Open()

    $rs.SessionStateProxy.SetVariable('serverUrl',   $cfg.serverUrl)
    $rs.SessionStateProxy.SetVariable('agentToken',  $cfg.agentToken)
    $rs.SessionStateProxy.SetVariable('tmpDir',      $TmpDir)
    $rs.SessionStateProxy.SetVariable('sumatraExe',  $SumatraExe)
    $rs.SessionStateProxy.SetVariable('logPath',     $LogPath)
    $script:needsRefresh = [ref]$false
    $rs.SessionStateProxy.SetVariable('statusRef',       ([ref]$script:wsConnected))
    $rs.SessionStateProxy.SetVariable('jobCountRef',     ([ref]$script:jobCount))
    $rs.SessionStateProxy.SetVariable('autoPrintRef',     ([ref]$script:autoPrint))
    $rs.SessionStateProxy.SetVariable('soundAlertRef',    ([ref]$script:soundAlert))
    $rs.SessionStateProxy.SetVariable('autoEnhanceRef',   ([ref]$script:autoEnhance))
    $rs.SessionStateProxy.SetVariable('needsRefreshRef',  $script:needsRefresh)
    $rs.SessionStateProxy.SetVariable('enhanceCode',      $script:EnhanceDocCode)
    $pName = if ($cfg.printerName) { $cfg.printerName } else { '' }
    $rs.SessionStateProxy.SetVariable('printerName', $pName)

    $wsScript = {
        if ($enhanceCode) {
            try { . ([scriptblock]::Create($enhanceCode)) } catch {}
        }
        function WLog([string]$msg) {
            $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            Add-Content -Path $logPath -Value "[$ts][WS] $msg" -ErrorAction SilentlyContinue
        }
        function ApiCall([string]$method, [string]$url, $body=$null) {
            $h = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $agentToken" }
            $p = @{ Method=$method; Uri=$url; Headers=$h; UseBasicParsing=$true; TimeoutSec=20; ErrorAction='Stop' }
            if ($body) { $p['Body'] = ($body | ConvertTo-Json -Compress) }
            return (Invoke-WebRequest @p).Content | ConvertFrom-Json
        }
        function DoPrint([string]$filePath, $opts) {
            $printer = if ($printerName) { $printerName } elseif ($opts.printerName) { $opts.printerName } else { '' }
            $copies  = if ($opts.copies -and [int]$opts.copies -gt 1) { [int]$opts.copies } else { 1 }
            $paper   = if ($opts.paperSize) { $opts.paperSize } else { 'A4' }
            $parts   = @('fit', "paper=$paper")
            if ($opts.orientation -eq 'landscape')  { $parts += 'landscape' }
            elseif ($opts.orientation -eq 'portrait') { $parts += 'portrait' }
            if ($opts.duplexMode -eq 'duplexlong')  { $parts += 'duplex' }
            if ($opts.duplexMode -eq 'duplexshort') { $parts += 'duplexshort' }
            if ($opts.colorMode -eq 'color')        { $parts += 'color' } else { $parts += 'monochrome' }
            if ($copies -gt 1)                      { $parts += "copies=$copies" }
            $settings = $parts -join ','
            $pArgs = @('-print-settings', $settings, '-silent', '-exit-when-done')
            if ($printer) { $pArgs = @('-print-to', "`"$printer`"") + $pArgs } else { $pArgs = @('-print-to-default') + $pArgs }
            $pArgs += "`"$filePath`""
            WLog "Print: $($pArgs -join ' ')"
            $proc = Start-Process -FilePath $sumatraExe -ArgumentList $pArgs -Wait -PassThru -WindowStyle Hidden
            return ($proc.ExitCode -eq 0)
        }
        function ProcessJob([string]$jobId) {
            WLog "Processing job $jobId"
            try {
                $meta = ApiCall 'GET' "$serverUrl/api/agent/jobs/$jobId/download-url"
                $allOk = $true
                foreach ($file in $meta.files) {
                    $ext = [System.IO.Path]::GetExtension($file.originalFilename)
                    if (-not $ext) { $ext = '.pdf' }
                    $tmp = "$tmpDir\$jobId$ext"
                    WLog "Downloading $($file.originalFilename)"
                    $wc = New-Object System.Net.WebClient
                    $wc.DownloadFile($file.downloadUrl, $tmp)
                    $wc.Dispose()

                    $printTarget = $tmp
                    $enhancedTmp = "$tmpDir\enhanced_$jobId.jpg"
                    if ($autoEnhanceRef.Value -and ($ext -match '^\.(jpe?g|png|bmp|jfif|webp|tiff?)$')) {
                        WLog "Auto-enhancing document photo for crisp print output..."
                        try {
                            $colorMode = if ($meta.printOptions.colorMode) { $meta.printOptions.colorMode } else { 'monochrome' }
                            $enhanced = Enhance-DocumentImage $tmp $enhancedTmp $colorMode
                            if ($enhanced -and (Test-Path $enhancedTmp)) {
                                $printTarget = $enhancedTmp
                                WLog "Auto-enhancement applied (A4 300DPI whitened/sharpened)"
                            } else {
                                WLog "Auto-enhancement returned false, using original file"
                            }
                        } catch {
                            WLog "Auto-enhancement error: $($_.Exception.Message), using original file"
                        }
                    }

                    $ok = DoPrint $printTarget $meta.printOptions
                    if (-not $ok) { $allOk = $false }
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                    Remove-Item $enhancedTmp -Force -ErrorAction SilentlyContinue
                }
                $outcome = if ($allOk) { 'SUCCESS' } else { 'UNCERTAIN' }
                $opId    = [System.Guid]::NewGuid().ToString()
                try { ApiCall 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome=$outcome; opId=$opId } | Out-Null } catch {}
                WLog "Job $jobId -> $outcome"
                if ($allOk) { $jobCountRef.Value++ }
                $needsRefreshRef.Value = $true
            } catch {
                WLog "Job $jobId error: $($_.Exception.Message)"
                try { ApiCall 'POST' "$serverUrl/api/agent/jobs/$jobId/status" @{ outcome='UNCERTAIN'; reason=$_.Exception.Message } | Out-Null } catch {}
                $needsRefreshRef.Value = $true
            }
        }
        function SyncPending {
            try {
                $res = ApiCall 'GET' "$serverUrl/api/agent/jobs?limit=20"
                if ($autoPrintRef.Value) {
                    foreach ($j in $res.jobs) { ProcessJob $j.jobId }
                    WLog "Synced $($res.jobs.Count) pending job(s) and auto-printed"
                } else {
                    WLog "Found $($res.jobs.Count) pending job(s) (held for vendor approval in Semi-Auto mode)"
                }
                $needsRefreshRef.Value = $true
            } catch { WLog "Sync error: $($_.Exception.Message)" }
        }

        while ($true) {
            try {
                $wsUrl = ($serverUrl -replace '^http','ws') + "/ws/agent?token=$([Uri]::EscapeDataString($agentToken))"
                $ws    = New-Object System.Net.WebSockets.ClientWebSocket
                $cts   = New-Object System.Threading.CancellationTokenSource
                $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
                $statusRef.Value = $true
                WLog "WebSocket connected to $serverUrl"
                SyncPending

                # Use strongly-typed array (avoids PSObject wrapping)
                $buf     = [byte[]]::new(8192)
                $segType = [System.ArraySegment``1].MakeGenericType([byte])
                $seg     = $segType.GetConstructors()[1].Invoke([object[]]@($buf, [int]0, [int]$buf.Length))
                $sb      = New-Object System.Text.StringBuilder

                while ($ws.State -eq 'Open') {
                    $res = $ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
                    if ($res.MessageType -eq 'Close') {
                        $ws.CloseAsync('NormalClosure','', $cts.Token).GetAwaiter().GetResult()
                        break
                    }
                    $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) | Out-Null
                    if ($res.EndOfMessage) {
                        $raw = $sb.ToString(); $sb.Clear()
                        try {
                            $msg = $raw | ConvertFrom-Json
                            if ($msg.type -eq 'job' -and $msg.id) {
                                $jid = $msg.id
                                if ($soundAlertRef.Value) {
                                    try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
                                }
                                if ($autoPrintRef.Value) {
                                    WLog "Auto-printing incoming job $jid"
                                    [System.Threading.Tasks.Task]::Run({
                                        ProcessJob $jid
                                        $needsRefreshRef.Value = $true
                                    }) | Out-Null
                                } else {
                                    WLog "Job $jid received in Semi-Auto mode (awaiting vendor approval)"
                                }
                                $needsRefreshRef.Value = $true
                            }
                        } catch {}
                    }
                }
            } catch { WLog "WS error: $($_.Exception.Message)" }
            $statusRef.Value = $false
            WLog 'Disconnected. Reconnecting in 6s...'
            Start-Sleep -Seconds 6
        }
    }

    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $rs
    $ps.AddScript($wsScript) | Out-Null
    $ps.BeginInvoke() | Out-Null

    # -- Auto-refresh timer ------------------------------------
    $refreshTimer = New-Object System.Windows.Forms.Timer
    $refreshTimer.Interval = 1000   # 1-second interval for real-time responsiveness
    $script:sWsLabel = $sWsLabel; $script:wsConnLbl = $wsConnLbl
    $script:connStatusLbl = $connStatusLbl; $script:sessionJobsLbl = $sessionJobsLbl
    $script:periodicCount = 0

    $refreshTimer.add_Tick({
        if ($script:wsConnected) {
            $script:sWsLabel.Text      = 'Connected'
            $script:sWsLabel.ForeColor = $script:C.Green
            $script:wsConnLbl.Text     = 'Connected (WebSocket active)'
            $script:wsConnLbl.ForeColor = $script:C.Green
            $script:connStatusLbl.Text      = 'Connected to server'
            $script:connStatusLbl.ForeColor = $script:C.Green
        } else {
            $script:sWsLabel.Text      = 'Offline'
            $script:sWsLabel.ForeColor = $script:C.Red
            $script:wsConnLbl.Text     = 'Disconnected - reconnecting...'
            $script:wsConnLbl.ForeColor = $script:C.Red
            $script:connStatusLbl.Text      = 'Disconnected'
            $script:connStatusLbl.ForeColor = $script:C.Red
        }
        $script:sessionJobsLbl.Text = $script:jobCount.ToString()

        $script:periodicCount++
        $doRefresh = $false

        if ($script:needsRefresh.Value) {
            $script:needsRefresh.Value = $false
            $doRefresh = $true
        } elseif ($script:periodicCount -ge 6) {
            $script:periodicCount = 0
            $doRefresh = $true
        }

        if ($doRefresh) {
            if ($script:pages['Dashboard'] -and $script:pages['Dashboard'].Visible) {
                try { script:Refresh-Dashboard } catch {}
            }
            if ($script:pages['PrintJobs'] -and $script:pages['PrintJobs'].Visible) {
                try { script:Refresh-Jobs } catch {}
            }
        }
    })
    $refreshTimer.Start()

    $win.add_FormClosed({
        $refreshTimer.Stop()
        $tray.Visible = $false
        try { $ps.Stop(); $rs.Close() } catch {}
    })

    # Bring window to front when shown
    $win.Add_Shown({
        $this.Activate()
        $this.BringToFront()
    })

    # -- Initial page load -------------------------------------
    script:Switch-Page 'Dashboard'

    $initTimer = New-Object System.Windows.Forms.Timer
    $initTimer.Interval = 300
    $initTimer.add_Tick({
        $initTimer.Stop()
        try { script:Refresh-Dashboard } catch {}
        try { script:Load-QR } catch {}
        try { script:Load-Settings } catch {}
    })
    $initTimer.Start()

    $tray.BalloonTipTitle = "QrPrintDesk - $($cfg.shopName)"
    $tray.BalloonTipText  = "Dashboard running. Station: $($cfg.agentName)"
    $tray.BalloonTipIcon  = 'Info'
    $tray.ShowBalloonTip(4000)

    [System.Windows.Forms.Application]::Run($win)
}

# -- Entry Point -----------------------------------------------
try {
    $cfg = Read-Config
    if (-not $cfg -or -not $cfg.agentToken) {
        Write-Log 'INFO' 'No config - launching setup wizard'
        $cfg = Show-SetupWizard
        if (-not $cfg) {
            Write-Log 'INFO' 'Setup cancelled.'
            exit 0
        }
        Write-Log 'INFO' "Registered as '$($cfg.agentName)' on $($cfg.serverUrl)"
    } else {
        Write-Log 'INFO' "Config loaded. Shop='$($cfg.shopName)' Server='$($cfg.serverUrl)'"
    }
    Build-VendorDashboard $cfg
} catch {
    $errText = "FATAL CRASH: $($_.Exception.ToString())`nStack: $($_.ScriptStackTrace)"
    Write-Log 'ERROR' $errText
    [System.Windows.Forms.MessageBox]::Show(
        "QrPrintDesk Error:`n$($_.Exception.Message)`n`nDetails logged to: $LogPath",
        'QrPrintDesk Error', 'OK', 'Error') | Out-Null
    exit 1
}
