# ============================================================
#  QrPrintDesk - Build Windows Installer (EXE)
#  Builds standalone QrPrintDesk_Setup.exe
# ============================================================

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  QrPrintDesk - Building Windows Installer (EXE)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# â”€â”€ Step 1: Locate portable or installed Inno Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€
$isccCandidates = @(
  (Join-Path $Root "bin\innosetup\app\ISCC.exe"),
  (Join-Path $Root "bin\innosetup\ISCC.exe"),
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
)

$iscc = $null
foreach ($p in $isccCandidates) {
  if (Test-Path $p) { $iscc = $p; break }
}

if (-not $iscc) {
  Write-Host "[1/2] Portable Inno Setup not found. Setting up..." -ForegroundColor Yellow
  $setupScript = Join-Path $PSScriptRoot "setup_portable_inno.ps1"
  if (Test-Path $setupScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $setupScript
  }
  foreach ($p in $isccCandidates) {
    if (Test-Path $p) { $iscc = $p; break }
  }
}

if (-not $iscc) {
  Write-Host "[!] Could not locate Inno Setup compiler (ISCC.exe)" -ForegroundColor Red
  exit 1
}

Write-Host "[1/2] Using compiler: $iscc" -ForegroundColor Green

# â”€â”€ Step 2: Compile installer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Write-Host "[2/2] Compiling QrPrintDesk_Setup.exe (LZMA2 compression)..." -ForegroundColor Yellow

$issFile = Join-Path $PSScriptRoot "QrPrintDesk.iss"
$distDir = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

& $iscc $issFile

if ($LASTEXITCODE -eq 0) {
  $output = Join-Path $distDir "QrPrintDesk_Setup.exe"
  if (Test-Path $output) {
    $size = [math]::Round((Get-Item $output).Length / 1MB, 1)
    $desktop = [System.Environment]::GetFolderPath('Desktop')
    $desktopFile = Join-Path $desktop "QrPrintDesk_Setup.exe"
    Copy-Item $output -Destination $desktopFile -Force

    Write-Host ""
    Write-Host "======================================================" -ForegroundColor Green
    Write-Host "  SUCCESS! QrPrintDesk_Setup.exe created!" -ForegroundColor Green
    Write-Host "======================================================" -ForegroundColor Green
    Write-Host "  Output File:  $output" -ForegroundColor Green
    Write-Host "  Desktop Copy: $desktopFile" -ForegroundColor Green
    Write-Host "  File Size:    $size MB" -ForegroundColor Green
    Write-Host ""
    Write-Host "  How to use:" -ForegroundColor White
    Write-Host "  1. Copy QrPrintDesk_Setup.exe to any Windows PC" -ForegroundColor Gray
    Write-Host "  2. Double-click to install (installs to C:\QrPrintDesk)" -ForegroundColor Gray
    Write-Host "  3. Start Menu & Desktop shortcuts are created automatically" -ForegroundColor Gray
    Write-Host ""
  } else {
    Write-Host "[!] Compiler finished but $output was not found." -ForegroundColor Red
  }
} else {
  Write-Host ""
  Write-Host "[!] Compilation failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit 1
}
