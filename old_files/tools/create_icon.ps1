Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap 48, 48
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Solid Royal Blue Rounded rect
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 10
$rect = New-Object System.Drawing.Rectangle 1, 1, 46, 46
$path.AddArc($rect.X, $rect.Y, $r*2, $r*2, 180, 90)
$path.AddArc($rect.Right - $r*2, $rect.Y, $r*2, $r*2, 270, 90)
$path.AddArc($rect.Right - $r*2, $rect.Bottom - $r*2, $r*2, $r*2, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r*2, $r*2, $r*2, 90, 90)
$path.CloseFigure()

$blueBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
$g.FillPath($blueBrush, $path)

# Printer graphics
$bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$paperTopBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 224, 242, 254))
$accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 16, 185, 129))
$slotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 41, 59))

$g.FillRectangle($paperTopBrush, 14, 9, 20, 10)
$g.FillRectangle($bodyBrush, 9, 17, 30, 16)
$g.FillRectangle($slotBrush, 14, 25, 20, 4)
$g.FillRectangle($paperTopBrush, 14, 28, 20, 9)
$g.FillEllipse($accentBrush, 32, 19, 4, 4)

$g.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create("H:\Print\public\app.ico")
$icon.Save($fs)
$fs.Close()
Write-Host "app.ico generated successfully at H:\Print\public\app.ico"
