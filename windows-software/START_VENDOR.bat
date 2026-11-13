@echo off
title QrPrintDesk Vendor Dashboard
cd /d "%~dp0"
echo ====================================================
echo   QrPrintDesk Vendor System
echo   Visual Dashboard + Cloud Print Station
echo ====================================================
echo.
echo  Starting QrPrintDesk Vendor Dashboard...
echo.
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0tools\QrPrintDesk-vendor.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Application stopped or encountered an error.
    pause
)
