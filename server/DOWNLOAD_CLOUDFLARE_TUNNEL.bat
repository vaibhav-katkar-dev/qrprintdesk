@echo off
setlocal
title Download Cloudflare Tunnel (cloudflared)
color 0B
cd /d "%~dp0"

echo ============================================================
echo   Downloading Cloudflare Tunnel CLI (cloudflared.exe)
echo ============================================================
echo.
echo [*] Downloading latest cloudflared-windows-amd64.exe into bin\ ...

if not exist "bin" mkdir bin

powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'bin\cloudflared.exe'"

if exist "bin\cloudflared.exe" (
    echo.
    echo [OK] cloudflared.exe downloaded successfully to bin\cloudflared.exe!
    echo [*] Now when you run SETUP_AND_START.bat or START_BACKGROUND.bat,
    echo     your server will automatically get a free public HTTPS URL!
) else (
    echo.
    echo [ERROR] Download failed. Please download manually from:
    echo https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    echo and place it into H:\Print\server\bin\cloudflared.exe
)

echo.
pause
