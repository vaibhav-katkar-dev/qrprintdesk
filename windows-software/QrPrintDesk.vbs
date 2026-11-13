' QrPrintDesk Agent & Vendor Dashboard â€” Silent launcher (no console window)
On Error Resume Next
Dim oFSO, oShell
Set oFSO   = CreateObject("Scripting.FileSystemObject")
Set oShell = CreateObject("WScript.Shell")
Dim scriptDir
scriptDir = oFSO.GetParentFolderName(WScript.ScriptFullName)

Dim ps1
ps1 = scriptDir & "\tools\QrPrintDesk-vendor.ps1"
If Not oFSO.FileExists(ps1) Then
    ps1 = scriptDir & "\tools\QrPrintDesk-agent.ps1"
End If

If Not oFSO.FileExists(ps1) Then
    MsgBox "Missing application script in " & scriptDir & "\tools\" & Chr(13) & Chr(10) & "Please reinstall QrPrintDesk.", 16, "QrPrintDesk Error"
    WScript.Quit 1
End If

Dim cmd
cmd = "powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File """ & ps1 & """"
oShell.Run cmd, 0, False

