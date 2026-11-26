[Setup]
AppName=QrPrintDesk Vendor Station
AppVersion=2.0.0
AppPublisher=QrPrintDesk
DefaultDirName={pf}\QrPrintDesk
DefaultGroupName=QrPrintDesk
OutputDir=H:\Print\vendor-desktop\installer
OutputBaseFilename=QrPrintDesk_Vendor_Setup
Compression=lzma2/max
SolidCompression=yes
SetupIconFile=H:\Print\vendor-desktop\dist\resources\app\assets\icon.ico
UninstallDisplayIcon={app}\QrPrintDesk.exe
PrivilegesRequired=admin

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; GroupDescription: "Additional Icons:"

[Files]
Source: "H:\Print\vendor-desktop\dist\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs;

[Icons]
Name: "{group}\QrPrintDesk Vendor Station"; Filename: "{app}\QrPrintDesk.exe"
Name: "{autodesktop}\QrPrintDesk Vendor Station"; Filename: "{app}\QrPrintDesk.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\QrPrintDesk.exe"; Description: "Launch QrPrintDesk Vendor Station"; Flags: nowait postinstall skipifsilent