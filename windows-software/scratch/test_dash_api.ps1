$cfg = Get-Content 'H:\Print\windows-software\data\config.json' -Raw | ConvertFrom-Json
$token = $cfg.agentToken
$url   = $cfg.serverUrl

# Test vendor dashboard API
try {
    $h = @{ Authorization = "Bearer $token" }
    $dash = Invoke-WebRequest -Uri "$url/api/vendor/dashboard" -Headers $h -UseBasicParsing -TimeoutSec 10
    Write-Host "=== DASHBOARD ==="
    Write-Host $dash.Content
} catch {
    Write-Host "DASHBOARD ERROR: $($_.Exception.Message)"
}

# Test vendor jobs API
try {
    $h = @{ Authorization = "Bearer $token" }
    $jobs = Invoke-WebRequest -Uri "$url/api/vendor/jobs?limit=20" -Headers $h -UseBasicParsing -TimeoutSec 10
    Write-Host "=== JOBS ==="
    Write-Host $jobs.Content
} catch {
    Write-Host "JOBS ERROR: $($_.Exception.Message)"
}
