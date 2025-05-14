# Stage 1: Build
FROM --platform=linux/amd64 oven/bun:1.1-alpine AS builder
WORKDIR /app

# Install curl for debugging and git for potential dependencies
RUN apk add --no-cache curl git

# Copy package files first
COPY package.json ./
COPY tsconfig.json ./
COPY bun.lockb* ./

# Remove the postinstall script from package.json before installing
RUN sed -i '/"postinstall"/d' package.json

# Install dependencies (including dev dependencies for TypeScript compilation)
RUN bun install

# Copy source code
COPY . .

# Debug: List files to verify source files are copied correctly
RUN find . -type f -name "*.ts" -o -name "*.js" | sort

# Build the TypeScript application manually
RUN rm -rf dist && mkdir -p dist && bun x tsc --skipLibCheck && mkdir -p dist/public

# Stage 2: Runtime
FROM --platform=linux/amd64 oven/bun:1.1-alpine
WORKDIR /app

# Install required runtime dependencies
RUN apk add --no-cache curl

# Copy production assets with proper permissions
COPY --chown=1000:1000 --from=builder /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/dist ./dist
COPY --chown=1000:1000 --from=builder /app/package.json ./
COPY --chown=1000:1000 --from=builder /app/public ./public

# Environment variables
ENV PORT=3000 \
    NODE_ENV=production \
    BUN_ENV=production

# Required environment variables for the app
ENV AUGMENTOS_API_KEY="" \
    AQI_TOKEN="" \
    PACKAGE_NAME="air-quality-app" \
    ENABLE_LOCATION_FALLBACK="true" \
    LOCATION_TIMEOUT_MS="10000" \
    DEFAULT_LAT="51.5074" \
    DEFAULT_LON="-0.1278"

EXPOSE $PORT
USER 1000

# Health check using the /health endpoint from your code
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:$PORT/health || exit 1

# Start the application
CMD ["bun", "dist/index.js"]