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
#define SrcDir       "H:\Print"

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
; --- Core application files ---
Source: "{#SrcDir}\src\*";            DestDir: "{app}\src";          Excludes: "*.sqlite*,*.sqlite-journal"; Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\public\*";         DestDir: "{app}\public";       Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\tools\*";          DestDir: "{app}\tools";        Excludes: "check_*,test_*,try_*,get_*,*.tmp"; Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\bin\*";            DestDir: "{app}\bin";          Excludes: "innosetup*,*.7z,*.zip"; Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\node_modules\*";   DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\package.json";     DestDir: "{app}";              Flags: ignoreversion
Source: "{#SrcDir}\package-lock.json"; DestDir: "{app}";             Flags: ignoreversion
Source: "{#SrcDir}\ShopPrint.bat";    DestDir: "{app}";              Flags: ignoreversion
Source: "{#SrcDir}\ShopPrint.vbs";    DestDir: "{app}";              Flags: ignoreversion
Source: "{#SrcDir}\app.ico";          DestDir: "{app}";              Flags: ignoreversion

[Dirs]
Name: "{app}\temp";   Permissions: users-full
Name: "{app}\src";    Permissions: users-full
Name: "{app}\data";   Permissions: users-full

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
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Stop-Process -Name node,cloudflared -Force -ErrorAction SilentlyContinue"""; Flags: nowait runhidden

