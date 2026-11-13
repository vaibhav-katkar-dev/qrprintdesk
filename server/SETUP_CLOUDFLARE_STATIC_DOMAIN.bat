@echo off
setlocal
title Setup Cloudflare Named Tunnel with Custom Domain
color 0B
cd /d "%~dp0"

echo ============================================================
echo   Cloudflare Named Tunnel Setup (Static Custom Domain)
echo ============================================================
echo.

set "CF_EXE="
if exist "%~dp0bin\cloudflared.exe" set "CF_EXE=%~dp0bin\cloudflared.exe"
if exist "C:\cloudflared\cloudflared.exe" set "CF_EXE=C:\cloudflared\cloudflared.exe"
where cloudflared >nul 2>&1 && set "CF_EXE=cloudflared"

if not defined CF_EXE (
    echo [!] cloudflared.exe not found!
    echo Running DOWNLOAD_CLOUDFLARE_TUNNEL.bat first...
    call DOWNLOAD_CLOUDFLARE_TUNNEL.bat
    if exist "%~dp0bin\cloudflared.exe" set "CF_EXE=%~dp0bin\cloudflared.exe"
)

echo.
echo Paste the Cloudflare Tunnel Token below.
echo (You get this from Cloudflare Zero Trust Dashboard -> Networks -> Tunnels -> Install connector -> Windows command)
echo.
set /p CF_TOKEN="Enter Cloudflare Tunnel Token: "

if "%CF_TOKEN%"=="" (
    echo [ERROR] Token cannot be empty.
    pause
    exit /b 1
)

echo.
echo [*] Saving token to config/tunnel_token.txt ...
if not exist "config" mkdir config
echo %CF_TOKEN% > config\tunnel_token.txt

echo.
echo [1] Do you want to install Cloudflare Tunnel as an official Windows Service (starts on PC boot)?
echo [2] Just save token for START_BACKGROUND.bat / SETUP_AND_START.bat
set /p CHOICE="Choose 1 or 2: "

if "%CHOICE%"=="1" (
    echo.
    echo [*] Installing Windows Service... (Requires Run as Administrator)
    "%CF_EXE%" service install %CF_TOKEN%
    echo [OK] Cloudflare Tunnel service installed! It will run 24/7 on boot.
) else (
    echo [OK] Token saved. START_BACKGROUND.bat and SETUP_AND_START.bat will use this token!
)

echo.
pause
