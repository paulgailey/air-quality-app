# Stage 1: Build
FROM --platform=linux/amd64 oven/bun:1.1-alpine AS builder
WORKDIR /app

# Install git (curl is already in base image)
RUN apk add --no-cache git

# Copy only package files first for caching
COPY ["bun.lockb", "package.json", "tsconfig.json", "./"]

# Remove postinstall script before install
RUN sed -i '/"postinstall"/d' package.json

# Install dependencies with reduced workers to avoid memory spikes
RUN bun install --no-progress --max-workers=1

# Copy source files
COPY ./src/ ./src/
COPY ./public/ ./public/ 2>/dev/null || true

# Ensure types dir exists
RUN mkdir -p ./types

# Temporary index.ts as entrypoint
RUN echo "// Main application entry point\nexport * from './src/index';" > index.ts

# Build TypeScript (use less memory)
RUN rm -rf dist && \
    mkdir -p dist/public && \
    bun x tsc --skipLibCheck

# Stage 2: Runtime
FROM --platform=linux/amd64 oven/bun:1.1-alpine
WORKDIR /app

# Copy production build
COPY --chown=1000:1000 --from=builder /app/dist ./dist
COPY --chown=1000:1000 --from=builder /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/public ./public
COPY --chown=1000:1000 --from=builder /app/package.json ./

# Runtime env
ENV PORT=3000 \
    NODE_ENV=production \
    BUN_ENV=production \
    AUGMENTOS_API_KEY="" \
    AQI_TOKEN="" \
    PACKAGE_NAME="air-quality-app" \
    ENABLE_LOCATION_FALLBACK="true" \
    LOCATION_TIMEOUT_MS="10000" \
    DEFAULT_LAT="51.5074" \
    DEFAULT_LON="-0.1278"

EXPOSE $PORT
USER 1000

# Healthcheck using curl
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:$PORT/health || exit 1

CMD ["bun", "dist/index.js"]
