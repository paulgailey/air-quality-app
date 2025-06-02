# ===== CONFIGURATION =====
$EC2_IP = "35.159.86.53"
$KEY_PATH = "C:\Users\paul\Documents\Code\AWS\prod-app-key.pem"
$LOCAL_ENV_PATH = "C:\Users\paul\Documents\Code\AugmentOS\air-quality-app\.env"
$REMOTE_APP_DIR = "/home/ubuntu/air-quality-app"

# ===== SECURE DEPLOYMENT =====
try {
    # 1. Verify .env exists locally
    if (-not (Test-Path $LOCAL_ENV_PATH)) {
        throw ".env file not found at $LOCAL_ENV_PATH"
    }

    Write-Host "📤 Uploading .env file to EC2..." -ForegroundColor Cyan
    scp -i $KEY_PATH -o StrictHostKeyChecking=no $LOCAL_ENV_PATH "ubuntu@${EC2_IP}:${REMOTE_APP_DIR}/.env"

    # 2. Connect and restart app
    Write-Host "🔄 Restarting app on EC2..." -ForegroundColor Cyan
    ssh -i $KEY_PATH ubuntu@${EC2_IP} @"
        set -e
        cd ${REMOTE_APP_DIR}

        echo '🔐 Locking .env permissions...'
        chmod 600 .env

        echo '📦 Checking node_modules...'
        if [ ! -d node_modules ]; then
            echo '📥 node_modules missing — running npm install...'
            npm install
        fi

        echo '🛠️ Checking build output...'
        if [ ! -d dist ]; then
            echo '🔧 dist missing — running build...'
            npm run build
        fi

        echo '🚀 Restarting app with PM2...'
        if pm2 restart air-quality-app; then
            echo '✅ App restarted via PM2'
        else
            echo '⚠️ PM2 restart failed — cold starting...'
            pm2 start dist/index.js --name "air-quality-app"
        fi
"@

    Write-Host "✅ Deployment complete and app restarted" -ForegroundColor Green
}
catch {
    Write-Host "❌ Deployment failed: $_" -ForegroundColor Red
    exit 1
}
