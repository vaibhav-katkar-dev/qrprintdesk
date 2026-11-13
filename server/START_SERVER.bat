@echo off
title ShopPrint Cloud Control Plane Server
cd /d "%~dp0"
color 0A
echo.
echo  ================================================
echo   ShopPrint Cloud Control Plane  ^|  Port 3000
echo  ================================================
echo.

:: Automatically free port 3000 if occupied by previous run
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo  STEP 1: Seeding MongoDB (shop + agent token)...
call npx tsx src/seed.ts
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Seed failed. Is MongoDB running?
    echo  Start MongoDB:  mongod --dbpath C:\data\db
    echo.
    pause
    exit /b 1
)

echo.
echo  STEP 2: Starting server...
echo.
echo  📱 Customer Mobile Print : http://localhost:3000/shop/default
echo  📊 Control Plane Status  : http://localhost:3000/status
echo  🩺 Health Check          : http://localhost:3000/health
echo  🔌 WebSocket Agent Hub   : ws://localhost:3000/ws/agent
echo.
echo  Press Ctrl+C to stop.
echo  ================================================
echo.
call npx tsx src/server.ts

pause
