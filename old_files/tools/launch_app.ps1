# Wait for server to come up (retry up to 30s)
$url = "http://localhost:3000/admin"
$maxWait = 30
$waited = 0

while ($waited -lt $maxWait) {
  Start-Sleep -Seconds 1
  $waited++
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/api/admin/auth-status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { break }
  } catch {}
}

# Small extra pause to ensure server has finished socket initialization
Start-Sleep -Milliseconds 800

$x86 = [System.Environment]::GetFolderPath('ProgramFilesX86')
$x64 = [System.Environment]::GetFolderPath('ProgramFiles')

$candidates = @(
  (Join-Path $x86 "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $x64 "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $x64 "Google\Chrome\Application\chrome.exe"),
  (Join-Path $x86 "Google\Chrome\Application\chrome.exe")
)

$launched = $false
foreach ($exe in $candidates) {
  if (Test-Path $exe) {
    try {
      Start-Process -FilePath $exe -ArgumentList @(
        "--new-window",
        "--app=$url",
        "--window-size=1360,860",
        "--window-position=40,20",
        "--no-first-run"
      ) -ErrorAction Stop
      $launched = $true
      break
    } catch {
      $launched = $false
    }
  }
}

if (-not $launched) {
  # Fallback: open in default browser
  Start-Process $url
}
