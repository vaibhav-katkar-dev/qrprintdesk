@echo off
title ShopPrint - Allow Mobile Devices (Firewall Setup)
cd /d "%~dp0"

echo ========================================================
echo   ShopPrint - Open Firewall Port 3000 for Mobile Phones
echo ========================================================
echo.

net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo [!] Requesting administrator permission to update Windows Firewall...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo [+] Removing any conflicting old rules...
netsh advfirewall firewall delete rule name="ShopPrint Port 3000" >nul 2>&1

echo [+] Allowing inbound TCP port 3000 on ALL network profiles (Private and Public)...
netsh advfirewall firewall add rule name="ShopPrint Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=any

echo.
echo ========================================================
echo  SUCCESS: Port 3000 is now accessible from Android/phones!
echo  Your Android phone can now connect to:
echo  http://192.168.0.101:3000
echo ========================================================
echo.
pause
