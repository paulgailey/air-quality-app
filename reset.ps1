# reset.ps1
param([switch]$Docker)

Write-Host "🚀 Resetting project..." -ForegroundColor Cyan

# 1. Clean project
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  node_modules, dist, package-lock.json, bun.lockb

# 2. Regenerate lockfile
if (Get-Command bun -ErrorAction SilentlyContinue) {
    bun install
}
else {
    npm install
}

# 3. Build
if (Test-Path "package.json") {
    if ((Get-Content package.json | ConvertFrom-Json).scripts.build) {
        npm run build
    }
}

# 4. Docker cleanup (optional)
if ($Docker) {
    docker system prune -f
}

Write-Host "✅ Reset complete!" -ForegroundColor Green