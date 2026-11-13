@echo off
setlocal
title ShopPrint - Setup Standalone Server PC
color 0B

echo ============================================================
echo   ShopPrint - Standalone Windows Server PC Optimization
echo ============================================================
echo.
echo  This script configures Windows to run 24/7 as a reliable server:
echo  1. Disables Sleep / Standby on AC Power
echo  2. Disables Hibernate
echo  3. Sets High Performance / Never sleep plan
echo.

echo [*] Disabling Sleep timeout when plugged in...
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 15
powercfg /change disk-timeout-ac 0
powercfg /hibernate off >nul 2>&1

echo [OK] Power settings updated: PC will NEVER sleep automatically!
echo.
echo [*] Tip for remote access:
echo     - Keep AnyDesk or RustDesk installed with unattended password.
echo     - Start server via START_BACKGROUND.bat so it runs in background.
echo.
pause
