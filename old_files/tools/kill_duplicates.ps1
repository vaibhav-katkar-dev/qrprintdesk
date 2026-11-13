# 1. Free port 3000 by killing any process currently listening on it
$connections = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
  if ($conn.OwningProcess -and $conn.OwningProcess -ne $PID) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

# 2. Kill duplicate cloudflared instances
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
