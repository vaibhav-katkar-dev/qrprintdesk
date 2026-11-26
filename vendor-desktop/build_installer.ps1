# QrPrintDesk Desktop Station - Automated Build & Inno Setup Script
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = 'H:\Print\vendor-desktop' }

$distDir = Join-Path $scriptDir 'dist'
$appDir = Join-Path $distDir 'resources\app'
$installerDir = Join-Path $scriptDir 'installer'
$iscc = Join-Path $scriptDir 'innosetup\app\ISCC.exe'

Write-Host "=========================================================="
Write-Host "  Building QrPrintDesk Vendor Desktop Installer"
Write-Host "=========================================================="

# 1. Ensure fresh app code inside dist/resources/app
Write-Host "1. Synchronizing latest source code into app bundle..."
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path $installerDir | Out-Null

Copy-Item -Path (Join-Path $scriptDir 'src') -Destination (Join-Path $appDir 'src') -Recurse -Force
Copy-Item -Path (Join-Path $scriptDir 'assets') -Destination (Join-Path $appDir 'assets') -Recurse -Force
if (Test-Path (Join-Path $scriptDir 'bin')) {
    Copy-Item -Path (Join-Path $scriptDir 'bin') -Destination (Join-Path $appDir 'bin') -Recurse -Force
}
Copy-Item -Path (Join-Path $scriptDir 'package.json') -Destination (Join-Path $appDir 'package.json') -Force

# 2. Write Inno Setup Script
Write-Host "2. Generating Inno Setup configuration..."
$iconPath = Join-Path $appDir 'assets\icon.ico'
$issContent = @"
[Setup]
AppName=QrPrintDesk Vendor Station
AppVersion=2.0.0
AppPublisher=QrPrintDesk
DefaultDirName={pf}\QrPrintDesk
DefaultGroupName=QrPrintDesk
OutputDir=$installerDir
OutputBaseFilename=QrPrintDesk_Vendor_Setup
Compression=lzma2/max
SolidCompression=yes
SetupIconFile=$iconPath
UninstallDisplayIcon={app}\QrPrintDesk.exe
PrivilegesRequired=admin

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; GroupDescription: "Additional Icons:"

[Files]
Source: "$distDir\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs;

[Icons]
Name: "{group}\QrPrintDesk Vendor Station"; Filename: "{app}\QrPrintDesk.exe"
Name: "{autodesktop}\QrPrintDesk Vendor Station"; Filename: "{app}\QrPrintDesk.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\QrPrintDesk.exe"; Description: "Launch QrPrintDesk Vendor Station"; Flags: nowait postinstall skipifsilent
"@

$issFile = Join-Path $scriptDir 'installer.iss'
[System.IO.File]::WriteAllText($issFile, $issContent, [System.Text.Encoding]::UTF8)

# 3. Compile with Inno Setup
Write-Host "3. Compiling Windows installer with Inno Setup..."
& $iscc $issFile

if ($LASTEXITCODE -eq 0) {
    $outputExe = Join-Path $installerDir 'QrPrintDesk_Vendor_Setup.exe'
    $sizeMB = [math]::Round((Get-Item $outputExe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "=========================================================="
    Write-Host "  BUILD SUCCESSFUL! Installer created: $outputExe ($sizeMB MB)"
    Write-Host "=========================================================="

    # Copy to public download and user desktop
    $publicDest = 'H:\Print\server\public\QrPrintDesk_Vendor_Setup.exe'
    Copy-Item -Path $outputExe -Destination $publicDest -Force -ErrorAction SilentlyContinue
    Write-Host "  Copied to Web Public Server: $publicDest"

    $desktopDest = Join-Path $env:USERPROFILE 'Desktop\QrPrintDesk_Vendor_Setup.exe'
    Copy-Item -Path $outputExe -Destination $desktopDest -Force -ErrorAction SilentlyContinue
    Write-Host "  Copied to User Desktop: $desktopDest"
} else {
    Write-Error "Installer compilation failed with code $LASTEXITCODE"
}
