@echo off
title ShopPrint - Cloudflare Tunnel Setup
cd /d "%~dp0"

echo ========================================================
echo   ShopPrint - Connect Your Company Subdomain
echo ========================================================
echo.

:: Check if already configured
if exist "bin\tunnel_token.txt" (
    echo [i] A tunnel token is already saved.
    set /p RECONFIGURE="Reconfigure with a new token? (y/n): "
    if /i not "%RECONFIGURE%"=="y" goto :start_tunnel
)

echo.
echo Step 1: Paste your Cloudflare Tunnel Token below.
echo (Get it from: dash.cloudflare.com ^> Zero Trust ^> Networks ^> Tunnels)
echo.
set /p TOKEN="Token: "
if "%TOKEN%"=="" (
    echo [ERROR] No token provided.
    pause
    exit /b
)
echo %TOKEN%> "bin\tunnel_token.txt"
echo [+] Token saved.

echo.
echo Step 2: Enter the public web link for this shop.
echo Example: https://shop1.yourcompany.com
echo.
set /p SUBDOMAIN="Your shop link: "
if not "%SUBDOMAIN%"=="" (
    node -e "import('./src/db.js').then(m => { m.setSetting('public_url', '%SUBDOMAIN%'); console.log('Saved!'); process.exit(0); });"
    echo [+] QR code will now point to: %SUBDOMAIN%
)

:start_tunnel
echo.
echo ========================================================
echo [*] Starting Cloudflare Tunnel...
echo ========================================================
set /p TOKEN=<"bin\tunnel_token.txt"
start "ShopPrint Cloudflare Tunnel" /min cmd /c "title ShopPrint Cloudflare Tunnel && cd /d \"%~dp0\" && bin\cloudflared.exe tunnel run --token %TOKEN%"

timeout /t 3 /nobreak >nul

echo.
echo ========================================================
echo  Tunnel is LIVE!
echo  Your printed counter QR code is now permanently active.
echo  Customers anywhere can scan and print!
echo ========================================================
echo.
echo TIP: To make this auto-start on PC boot (no window needed):
echo  Right-click INSTALL_TUNNEL_SERVICE.bat and "Run as administrator"
echo.
pause
