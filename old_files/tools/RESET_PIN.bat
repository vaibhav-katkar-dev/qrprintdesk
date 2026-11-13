@echo off
title ShopPrint - Set Master Admin PIN
cd /d "%~dp0\.."

echo ========================================================
echo         ShopPrint - Master Admin PIN Tool
echo ========================================================
echo.
echo Set or reset your shopkeeper console PIN.
echo (Press ENTER directly to use default PIN: 1234)
echo.

set /p USER_PIN="Enter new 4-digit PIN [Default: 1234]: "
if "%USER_PIN%"=="" set USER_PIN=1234

:: Find node runtime
if exist "bin\node.exe" (
    set "NODE_BIN=bin\node.exe"
) else (
    set "NODE_BIN=node"
)

echo.
"%NODE_BIN%" tools\reset_pin.mjs %USER_PIN%
echo.
pause
