; ============================================================
;  ShopPrint Installer Script  (Inno Setup)
;  Builds: ShopPrint_Setup.exe
;  Default Target: C:\ShopPrint
; ============================================================

#define AppName      "ShopPrint"
#define AppVersion   "1.0"
#define AppPublisher "ShopPrint"
#define AppURL       "http://localhost:3000"
#define AppExeName   "ShopPrint.vbs"
#define SrcDir       "H:\Print\windows-software"

[Setup]
AppId={{B3C7F2A1-4D5E-4F6A-8B9C-0D1E2F3A4B5C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName=C:\ShopPrint
DefaultGroupName={#AppName}
AllowNoIcons=yes
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
OutputDir={#SrcDir}\dist
OutputBaseFilename=ShopPrint_Setup
SetupIconFile={#SrcDir}\app.ico
PrivilegesRequired=admin
DisableProgramGroupPage=yes
AppComments=ShopPrint Station - Instant Customer Mobile Document Printing

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";  Description: "{cm:CreateDesktopIcon}";  GroupDescription: "{cm:AdditionalIcons}"

[Files]
; --- Lightweight Vendor Client Files ---
Source: "{#SrcDir}\tools\shopprint-vendor.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#SrcDir}\tools\shopprint-agent.ps1";  DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#SrcDir}\bin\SumatraPDF.exe";         DestDir: "{app}\bin";   Flags: ignoreversion
Source: "{#SrcDir}\ShopPrint.bat";              DestDir: "{app}";       Flags: ignoreversion
Source: "{#SrcDir}\ShopPrint.vbs";              DestDir: "{app}";       Flags: ignoreversion
Source: "{#SrcDir}\START_VENDOR.bat";           DestDir: "{app}";       Flags: ignoreversion
Source: "{#SrcDir}\app.ico";                    DestDir: "{app}";       Flags: ignoreversion

[Dirs]
Name: "{app}\data";     Permissions: users-full
Name: "{app}\data\tmp"; Permissions: users-full


[Icons]
; Start Menu shortcuts - point to VBS with custom icon
Name: "{group}\{#AppName}";             Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#AppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Comment: "Start ShopPrint Station"
Name: "{group}\Uninstall {#AppName}";   Filename: "{uninstallexe}"

; Desktop shortcut (checked by default)
Name: "{autodesktop}\{#AppName}";       Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#AppExeName}"""; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Comment: "Start ShopPrint Station"; Tasks: desktopicon

[Registry]
; Auto-start at Windows login (always registered on install)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ShopPrint"; ValueData: "wscript.exe ""{app}\ShopPrint.vbs"""; Flags: uninsdeletevalue
; Always show tray icons on taskbar (do not hide behind ^ chevron)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Explorer"; ValueType: dword; ValueName: "EnableAutoTray"; ValueData: 0; Flags: preservestringtype

[Run]
; Ask to launch after install (uses wscript so no terminal flashes)
Filename: "{sys}\wscript.exe"; Parameters: """{app}\{#AppExeName}"""; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop background processes on uninstall
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowTitle -like '*ShopPrint*' }} | Stop-Process -Force -ErrorAction SilentlyContinue"""; Flags: nowait runhidden; RunOnceId: "StopShopPrint"

