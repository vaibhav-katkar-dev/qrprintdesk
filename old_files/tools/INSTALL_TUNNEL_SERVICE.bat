@echo off
title ShopPrint - Install Cloudflare Tunnel as Windows Service
cd /d "%~dp0"

echo ========================================================
echo   ShopPrint - Installing Tunnel as Windows Service
echo   (Tunnel will auto-start even after PC reboots)
echo ========================================================
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo [!] This script needs Administrator rights.
    echo     Right-click this file and choose "Run as administrator".
    pause
    exit /b
)

if not exist "bin\tunnel_token.txt" (
    echo [ERROR] Token not found. Please run TUNNEL_SETUP.bat first.
    pause
    exit /b
)

set /p TOKEN=<"bin\tunnel_token.txt"

echo [1] Removing old service if exists...
bin\cloudflared.exe service uninstall >nul 2>&1

echo [2] Installing cloudflared as Windows service...
bin\cloudflared.exe service install %TOKEN%

if %errorlevel% EQU 0 (
    echo [3] Starting service now...
    net start cloudflared

    echo.
    echo ========================================================
    echo  SUCCESS! Cloudflare Tunnel is now a Windows SERVICE.
    echo  - It will auto-start every time this PC boots.
    echo  - No need to keep a window open.
    echo  - Your company subdomain is live 24/7!
    echo ========================================================
) else (
    echo.
    echo [ERROR] Service install failed. Check that you ran as Administrator.
)

echo.
pause
