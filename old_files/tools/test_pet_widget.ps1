Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cSharpCode = @"
using System;
using System.Runtime.InteropServices;
public class WinDragHelper {
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
    public const int WM_NCLBUTTONDOWN = 0xA1;
    public const int HT_CAPTION = 0x2;
}
"@
Add-Type -TypeDefinition $cSharpCode -ErrorAction SilentlyContinue

$f = New-Object System.Windows.Forms.Form
$f.Text = "ShopPrint Assistant"
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$f.Size = New-Object System.Drawing.Size(270, 70)
$f.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$f.TopMost = $true
$f.ShowInTaskbar = $false

# Screen position: bottom right, slightly above taskbar
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location = New-Object System.Drawing.Point(($screen.Right - 290), ($screen.Bottom - 90))

# Outer border panel
$border = New-Object System.Windows.Forms.Panel
$border.Size = New-Object System.Drawing.Size(268, 68)
$border.Location = New-Object System.Drawing.Point(1, 1)
$border.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$f.Controls.Add($border)

# Mascot Icon (Printer)
$iconBox = New-Object System.Windows.Forms.PictureBox
$iconBox.Size = New-Object System.Drawing.Size(36, 36)
$iconBox.Location = New-Object System.Drawing.Point(10, 16)
$iconBox.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage

# Load app icon if exists
$icoPath = "H:\Print\app.ico"
if (Test-Path $icoPath) {
    try {
        $iconBox.Image = [System.Drawing.Image]::FromFile($icoPath)
    } catch {}
}
$border.Controls.Add($iconBox)

# Title Label
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "SHOPPRINT ASSISTANT"
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Bold)
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$lblTitle.Location = New-Object System.Drawing.Point(52, 12)
$lblTitle.AutoSize = $true
$border.Controls.Add($lblTitle)

# Status Label
$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "[o] Ready for prints"
$lblStatus.Font = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(16, 185, 129) # Emerald Green
$lblStatus.Location = New-Object System.Drawing.Point(52, 30)
$lblStatus.AutoSize = $true
$border.Controls.Add($lblStatus)

# Hint / Expand Label
$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = "Click to open"
$lblHint.Font = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Regular)
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$lblHint.Location = New-Object System.Drawing.Point(52, 48)
$lblHint.AutoSize = $true
$border.Controls.Add($lblHint)

# Minimize button
$btnMin = New-Object System.Windows.Forms.Label
$btnMin.Text = "_"
$btnMin.Font = New-Object System.Drawing.Font("Segoe UI", 8.0, [System.Drawing.FontStyle]::Bold)
$btnMin.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$btnMin.Location = New-Object System.Drawing.Point(245, 4)
$btnMin.Size = New-Object System.Drawing.Size(16, 16)
$btnMin.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnMin.add_Click({ $f.Hide() })
$border.Controls.Add($btnMin)

# Form Paint (Border border)
$f.add_Paint({
    param($s, $e)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(59, 130, 246), 2)
    $e.Graphics.DrawRectangle($pen, 0, 0, 269, 69)
    $pen.Dispose()
})

# Make whole widget draggable & clickable
$clickOrDrag = {
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        [WinDragHelper]::ReleaseCapture()
        [WinDragHelper]::SendMessage($f.Handle, [WinDragHelper]::WM_NCLBUTTONDOWN, [WinDragHelper]::HT_CAPTION, 0)
    }
}

$border.add_MouseDown($clickOrDrag)
$iconBox.add_MouseDown($clickOrDrag)
$lblTitle.add_MouseDown($clickOrDrag)
$lblStatus.add_MouseDown($clickOrDrag)
$lblHint.add_MouseDown($clickOrDrag)

Write-Host "Showing test widget..."
$f.Show()
Start-Sleep -Seconds 4
$f.Dispose()
Write-Host "Test widget closed cleanly"
