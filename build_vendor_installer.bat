@echo off
echo ========================================================
echo   QrPrintDesk Vendor Station - One-Click Installer Build
echo ========================================================
echo.
echo [1/2] Syncing latest vendor-desktop source files to vendor-app runtime...
xcopy /E /I /Y "H:\Print\vendor-desktop\src\*" "H:\Print\vendor-app\resources\app\src\"
if errorlevel 1 (
    echo Error syncing source files.
    pause
    exit /b 1
)

echo.
echo [2/2] Compiling Windows Installer (ISCC)...
powershell -ExecutionPolicy Bypass -File "H:\Print\vendor-app\build_installer.ps1"
if errorlevel 1 (
    echo Compilation failed.
    pause
    exit /b 1
)

echo.
echo All Done! Updated QrPrintDesk_Vendor_Setup.exe has been created and placed on your Desktop.
