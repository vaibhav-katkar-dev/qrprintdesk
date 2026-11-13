@echo off
title ShopPrint - Install Cloudflare Tunnel (Permanent Service)
color 0A

:: ── Self-elevate to Administrator ─────────────────────────────────────────
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo Requesting Administrator rights...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: ── Config ─────────────────────────────────────────────────────────────────
set CF_EXE=C:\Program Files (x86)\cloudflared\cloudflared.exe
set TOKEN=eyJhIjoiMTE5MmU4Zjg1ZmQ4N2E3ZDQyZWFkYzM4MGZkMjUwMTUiLCJ0IjoiY2MxNjM1MTItOTNiMi00MzE0LThlZmYtYTZiOTc5NTE0NmVkIiwicyI6Ik1qbGxOekkxWWpndFpEQTJOaTAwTTJReUxUazBaVE10T0dSa09XSTJabVV6TUdGaCJ9

echo.
echo  ================================================================
echo   ShopPrint - Installing Cloudflare Tunnel as Windows Service
echo   Domain: okinsite.com
echo  ================================================================
echo.

:: ── Stop + remove any existing cloudflared service ────────────────────────
echo [1] Removing old service (if any)...
net stop cloudflared >nul 2>&1
"%CF_EXE%" service uninstall >nul 2>&1
timeout /t 2 /nobreak >nul

:: ── Install the service ───────────────────────────────────────────────────
echo [2] Installing cloudflared as Windows Service...
"%CF_EXE%" service install %TOKEN%

if %errorlevel% NEQ 0 (
    echo.
    echo [ERROR] Service install failed!
    echo         Make sure cloudflared is at:
    echo         %CF_EXE%
    pause
    exit /b 1
)

:: ── Start the service now ─────────────────────────────────────────────────
echo [3] Starting service now...
net start cloudflared
timeout /t 3 /nobreak >nul

:: ── Verify ────────────────────────────────────────────────────────────────
echo [4] Verifying...
sc query cloudflared | findstr /i "STATE"

echo.
echo  ================================================================
echo   SUCCESS! Cloudflare Tunnel is now a permanent Windows Service.
echo   - Auto-starts on every reboot (no window needed)
echo   - Domain: okinsite.com is ALWAYS live
echo   - Service name: cloudflared
echo  ================================================================
echo.
echo  To check status anytime:   sc query cloudflared
echo  To stop tunnel:            net stop cloudflared
echo  To restart tunnel:         net stop cloudflared ^& net start cloudflared
echo.
pause
