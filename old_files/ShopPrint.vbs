' ShopPrint.vbs - Silent Windows Launcher
' Double-click to launch ShopPrint silently with NO terminal window.

On Error Resume Next

Set oFSO   = CreateObject("Scripting.FileSystemObject")
Set oShell = CreateObject("WScript.Shell")

If Err.Number <> 0 Then
    MsgBox "Windows Script Host initialization failed: " & Err.Description, 16, "ShopPrint Error"
    WScript.Quit 1
End If

Dim scriptDir
scriptDir = oFSO.GetParentFolderName(WScript.ScriptFullName)

Dim psScript
psScript = scriptDir & "\tools\shopprint-tray.ps1"

If Not oFSO.FileExists(psScript) Then
    MsgBox "ShopPrint station installation appears damaged." & vbCrLf & _
           "Missing launcher: " & psScript & vbCrLf & vbCrLf & _
           "Please reinstall using ShopPrint_Setup.exe.", 16, "ShopPrint Error"
    WScript.Quit 1
End If

' Launch PowerShell hidden (0 = hidden, False = return immediately)
Dim cmd
cmd = "powershell.exe -NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & psScript & """"

Dim result
result = oShell.Run(cmd, 0, False)

If Err.Number <> 0 Then
    MsgBox "Failed to start ShopPrint: " & vbCrLf & Err.Description, 16, "ShopPrint Error"
    WScript.Quit 1
End If
