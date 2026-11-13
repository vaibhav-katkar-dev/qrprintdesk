@echo off
setlocal EnableDelayedExpansion
title ShopPrint Server - Auto Setup
color 0A
chcp 65001 >nul 2>&1

echo.
echo  ==========================================================
echo            SHOPPRINT SERVER - ONE CLICK SETUP             
echo  ==========================================================
echo.

set "SERVER_DIR=%~dp0"
set "SERVER_DIR=%SERVER_DIR:~0,-1%"
cd /d "%SERVER_DIR%"

echo  [*] Server directory: %SERVER_DIR%
echo.

:: STEP 1: Check Node.js
echo  STEP 1: Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [!] Node.js not found. Opening download page...
    start https://nodejs.org/en/download
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
echo  [OK] Node.js found: %NODE_VER%
echo.

:: STEP 2: Check MongoDB
echo  STEP 2: Checking MongoDB...
sc query MongoDB >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  [OK] MongoDB Windows Service found.
    net start MongoDB >nul 2>&1
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
        echo  [!] MongoDB not detected. Please make sure MongoDB service is active.
    )
)
echo.

:: STEP 3: Dependencies
if not exist "node_modules" (
    echo  STEP 3: Installing npm dependencies...
    call npm install
)

:: STEP 4: Free Port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: STEP 5: Database Seed
if not exist "logs" mkdir logs
call npx tsx src/seed.ts >nul 2>&1
echo  [OK] Database ready.
echo.

:: STEP 6: Network & IP Discovery
echo  STEP 6: Network Details...
set "LOCAL_IP=127.0.0.1"
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "RAW_IP=%%i"
    set "CLEAN_IP=!RAW_IP: =!"
    if not "!CLEAN_IP:~0,3!"=="127" (
        if not "!CLEAN_IP:~0,7!"=="169.254" (
            set "LOCAL_IP=!CLEAN_IP!"
        )
    )
)
echo  [OK] Local Network IP: !LOCAL_IP!
echo.

:: STEP 7: Cloudflare Tunnel
echo  STEP 7: Cloudflare Tunnel...
set "CF_EXE="
if exist "%SERVER_DIR%\bin\cloudflared.exe" set "CF_EXE=%SERVER_DIR%\bin\cloudflared.exe"
if exist "C:\cloudflared\cloudflared.exe" set "CF_EXE=C:\cloudflared\cloudflared.exe"
where cloudflared >nul 2>&1 && set "CF_EXE=cloudflared"

if defined CF_EXE (
    taskkill /F /IM cloudflared.exe >nul 2>&1
    if exist "logs\tunnel.log" del /F /Q "logs\tunnel.log"
    if exist "%SERVER_DIR%\config\tunnel_token.txt" (
        set /p CF_TOKEN=<"%SERVER_DIR%\config\tunnel_token.txt"
        echo  [*] Starting Static Custom Domain Cloudflare Tunnel...
        start /B "" "%CF_EXE%" tunnel run --token !CF_TOKEN! > logs\tunnel.log 2>&1
        echo  [OK] Static Named Tunnel is ACTIVE and CONNECTED!
    ) else (
        echo  [*] Starting Quick Cloudflare Tunnel...
        start /B "" "%CF_EXE%" tunnel --url http://localhost:3000 > logs\tunnel.log 2>&1
        timeout /t 6 /nobreak >nul
        for /f "tokens=*" %%u in ('findstr /R "trycloudflare\.com" logs\tunnel.log 2^>nul') do (
            echo  [PUBLIC URL]: %%u
        )
    )
) else (
    echo  [SKIP] cloudflared.exe not found in bin\
)

echo.
echo  ==========================================================
echo                   SERVER IS NOW RUNNING                    
echo  ==========================================================
echo   Local PC Access   : http://localhost:3000/shop/default
echo   Local Network IP  : http://!LOCAL_IP!:3000/shop/default
echo   Control Status    : http://localhost:3000/status
echo   WebSocket Agent   : ws://localhost:3000/ws/agent
if exist "%SERVER_DIR%\config\tunnel_token.txt" (
    echo   Custom Domain     : Static Tunnel Running via Cloudflare Token
)
echo  ==========================================================
echo   Press Ctrl+C to stop the server
echo.

call npx tsx src/server.ts
pause
