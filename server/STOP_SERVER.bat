@echo off
setlocal EnableDelayedExpansion
title ShopPrint - Stop Server
color 0C
chcp 65001 >nul 2>&1

echo.
echo  +----------------------------------------------------------+
echo  ^|              SHOPPRINT - STOP SERVER                    ^|
echo  +----------------------------------------------------------+
echo.

:: ============================================================
:: Stop PM2 app
:: ============================================================
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  [*] Stopping PM2 app: shopprint-control-plane...
    pm2 stop shopprint-control-plane >nul 2>&1
    pm2 delete shopprint-control-plane >nul 2>&1
    echo  [OK] PM2 app stopped.
) else (
    echo  [SKIP] PM2 not installed, skipping.
)

:: ============================================================
:: Kill server running directly (node / tsx / npx)
:: ============================================================
echo  [*] Killing any process on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    echo  [OK] Killed PID %%a on port 3000.
)

:: ============================================================
:: Kill Cloudflare Tunnel
:: ============================================================
echo  [*] Stopping Cloudflare Tunnel...
taskkill /F /IM cloudflared.exe >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  [OK] cloudflared.exe stopped.
) else (
    echo  [SKIP] cloudflared was not running.
)

:: ============================================================
:: Kill any stray node/tsx processes (optional - commented out)
:: Uncomment only if you want to kill ALL node processes
:: ============================================================
:: taskkill /F /IM node.exe >nul 2>&1

echo.
echo  +----------------------------------------------------------+
echo  ^|           ALL SHOPPRINT SERVICES STOPPED                ^|
echo  +----------------------------------------------------------+
echo.
echo  To start again: SETUP_AND_START.bat  (foreground)
echo                  START_BACKGROUND.bat (background, recommended)
echo.
pause
