# check-versions.ps1
param (
    [switch]$Fix = $false
)

# 1. Node Version Check
$expectedNode = "v22.15.0"
$currentNode = (node --version)
if ($currentNode -ne $expectedNode) {
    Write-Host -ForegroundColor Red "❌ Node version mismatch! Expected $expectedNode but got $currentNode"
    if ($Fix) {
        Write-Host "Installing correct Node version via Volta..."
        volta install node@$expectedNode
    }
} else {
    Write-Host -ForegroundColor Green "✅ Node version correct ($expectedNode)"
}

# 2. Ngrok Check
try {
    $ngrokPath = (Get-Command ngrok).Source
    $ngrokVersion = (ngrok --version 2>&1) -replace "[^0-9.]"
    $expectedNgrok = "3.22.1"
    
    if ($ngrokVersion -notmatch $expectedNgrok) {
        Write-Host -ForegroundColor Red "❌ ngrok version mismatch! Expected $expectedNgrok but found $ngrokVersion"
        Write-Host "Running from: $ngrokPath"
    } else {
        Write-Host -ForegroundColor Green "✅ ngrok version correct ($expectedNgrok)"
        Write-Host "Running from: $ngrokPath"
    }
} catch {
    Write-Host -ForegroundColor Red "❌ ngrok not found in PATH"
}

# 3. Bun Lockfile Check
if (Test-Path bun.lockb) {
    Write-Host -ForegroundColor Green "✅ bun.lockb exists"
} else {
    Write-Host -ForegroundColor Red "❌ Missing bun.lockb - run 'bun install'"
}

# 4. Critical Dependency Check
$deps = @{
    "@augmentos/sdk" = "1.0.7"
    "typescript" = "5.3.3"
}

foreach ($dep in $deps.Keys) {
    $found = (bun list | Select-String "$dep@$($deps[$dep])")
    if ($found) {
        Write-Host -ForegroundColor Green "✅ $dep@$($deps[$dep]) found"
    } else {
        Write-Host -ForegroundColor Red "❌ $dep@$($deps[$dep]) missing!"
    }
}

# Exit with error code if any checks failed
if ($Error.Count -gt 0) {
    exit 1
}