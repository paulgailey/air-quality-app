# Ensure correct ngrok version
./check-versions.ps1

# Start ngrok and app concurrently
Start-Process ngrok -ArgumentList "http 3000"
bun run src/index.ts