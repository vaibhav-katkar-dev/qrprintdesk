$url = "https://github.com/portapps/innosetup-portable/releases/download/7.1.0-6/innosetup-portable-win64-7.1.0-7.7z"
$dest7z = "bin\inno_portable.7z"
$targetDir = "bin\innosetup"
$7z = "C:\Program Files\7-Zip\7z.exe"

Write-Host "Downloading Inno Setup Portable 7.1.0 (~8 MB)..."
Invoke-WebRequest -Uri $url -OutFile $dest7z -UseBasicParsing
Write-Host "Download complete. Extracting with 7-Zip..."

& $7z x $dest7z "-o$targetDir" -y

Remove-Item $dest7z -Force -ErrorAction SilentlyContinue

$iscc = Get-ChildItem -Path $targetDir -Recurse -Filter "ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($iscc) {
  Write-Host "SUCCESS! Found ISCC.exe at: $($iscc.FullName)"
} else {
  Write-Host "Checking extracted files:"
  Get-ChildItem $targetDir | Select-Object Name
}
