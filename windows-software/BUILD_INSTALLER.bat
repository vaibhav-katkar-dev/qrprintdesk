@echo off
title QrPrintDesk - Build Windows Installer (.EXE)
echo.
echo ========================================================
echo   QrPrintDesk - Building Windows Installer Package (.EXE)
echo ========================================================
echo.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build_installer.ps1"
echo.
pause
