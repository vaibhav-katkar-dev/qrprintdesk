@echo off
setlocal EnableDelayedExpansion
title ShopPrint - Start in Background (PM2)
color 0A
chcp 65001 >nul 2>&1

echo.
echo  +----------------------------------------------------------+
echo  ^|        SHOPPRINT - BACKGROUND SERVER (PM2 MODE)         ^|
echo  ^|   Server runs silently. Close this window anytime.      ^|
echo  +----------------------------------------------------------+
echo.

:: Get the folder where this script lives
set "SERVER_DIR=%~dp0"
set "SERVER_DIR=%SERVER_DIR:~0,-1%"
cd /d "%SERVER_DIR%"

echo  [*] Server folder: %SERVER_DIR%
echo.

:: ============================================================
:: STEP 1 - Check Node.js
:: ============================================================
echo  [1/6] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Node.js not found!
    echo  Download from: https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

:: ============================================================
:: STEP 2 - Check MongoDB
:: ============================================================
echo  [2/6] Checking MongoDB...
sc query MongoDB >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    net start MongoDB >nul 2>&1
    echo  [OK] MongoDB service running.
) else (
    where mongod >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        tasklist /FI "IMAGENAME eq mongod.exe" 2>nul | findstr /I "mongod.exe" >nul
        if %ERRORLEVEL% NEQ 0 (
            if not exist "C:\data\db" mkdir "C:\data\db"
            start /B mongod --dbpath C:\data\db --port 27017 --quiet
            timeout /t 3 /nobreak >nul
        )
        echo  [OK] MongoDB running.
    ) else (
        echo  [ERROR] MongoDB not found!
        echo  Download: https://www.mongodb.com/try/download/community
        pause
        exit /b 1
    )
)

:: ============================================================
:: STEP 3 - Install dependencies if needed
:: ============================================================
echo  [3/6] Checking dependencies...
if not exist "node_modules" (
    echo  [*] Installing npm packages (first time, may take a minute)...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] npm install failed!
        pause
        exit /b 1
    )
)
echo  [OK] Dependencies ready.

:: ============================================================
:: STEP 4 - Check/Install PM2
:: ============================================================
echo  [4/6] Checking PM2...
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [*] PM2 not found. Installing globally...
    call npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] PM2 install failed!
        pause
        exit /b 1
    )
    echo  [OK] PM2 installed.
) else (
    echo  [OK] PM2 found.
)

:: ============================================================
:: STEP 5 - Seed Database
:: ============================================================
echo  [5/6] Seeding database...
if not exist "logs" mkdir logs
call npx tsx src/seed.ts >nul 2>&1
echo  [OK] Database ready.

:: ============================================================
:: STEP 6 - Start Cloudflare Tunnel (if cloudflared.exe present)
:: ============================================================
echo  [6/6] Starting Cloudflare Tunnel...
set "CF_EXE="
if exist "%SERVER_DIR%\bin\cloudflared.exe" set "CF_EXE=%SERVER_DIR%\bin\cloudflared.exe"
if exist "C:\cloudflared\cloudflared.exe" set "CF_EXE=C:\cloudflared\cloudflared.exe"
where cloudflared >nul 2>&1 && set "CF_EXE=cloudflared"

:: Kill existing tunnel
taskkill /F /IM cloudflared.exe >nul 2>&1

if defined CF_EXE (
    if exist "logs\tunnel.log" del /F /Q "logs\tunnel.log"
    if exist "%SERVER_DIR%\config\tunnel_token.txt" (
        set /p CF_TOKEN=<"%SERVER_DIR%\config\tunnel_token.txt"
        echo  [*] Starting Static Custom Domain Tunnel...
        start /B "" "%CF_EXE%" tunnel run --token !CF_TOKEN! > "logs\tunnel.log" 2>&1
        echo  [OK] Static Tunnel running in background!
    ) else (
        start /B "" "%CF_EXE%" tunnel --url http://localhost:3000 > "logs\tunnel.log" 2>&1
        echo  [OK] Tunnel starting...
        echo  [*]  Waiting for public URL (10 sec)...
        timeout /t 10 /nobreak >nul
        for /f "tokens=*" %%u in ('findstr /R "trycloudflare.com" "logs\tunnel.log" 2^>nul') do set "TUNNEL_LINE=%%u"
        echo  [*]  Tunnel log line: !TUNNEL_LINE!
    )
) else (
    echo  [SKIP] cloudflared.exe not found. Server will be local only.
    echo         To add: place cloudflared.exe in %SERVER_DIR%\bin\
)

:: ============================================================
:: Stop any existing PM2 instance of shopprint
:: ============================================================
pm2 delete shopprint-control-plane >nul 2>&1

:: ============================================================
:: Start server with PM2
:: ============================================================
echo.
echo  [*] Starting server with PM2...
pm2 start ecosystem.config.cjs
pm2 save >nul 2>&1

echo.
echo  +----------------------------------------------------------+
echo  ^|                  SERVER IS RUNNING!                     ^|
echo  +----------------------------------------------------------+
echo  ^|  Customer Print Page : http://localhost:3000/shop/      ^|
echo  ^|  Health Check        : http://localhost:3000/health     ^|
echo  ^|  PM2 Status          : pm2 status                      ^|
echo  ^|  Live Logs           : pm2 logs shopprint-control-plane ^|
echo  ^|  Stop Server         : STOP_SERVER.bat                  ^|
echo  +----------------------------------------------------------+
echo.

if defined CF_EXE (
    echo  [*] Check your public URL in: logs\tunnel.log
    echo  [*] Search for: trycloudflare.com
    echo  [*] Then update SERVER_BASE_URL in .env with that URL.
    echo.
    if exist "logs\tunnel.log" (
        echo  --- Tunnel Log (last 20 lines) ---
        powershell -Command "Get-Content 'logs\tunnel.log' -Tail 20"
        echo  ---------------------------------
    )
)

echo.
echo  [*] This window can be closed. Server runs in background.
echo.
pause
