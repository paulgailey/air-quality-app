# Stage 1: Build
FROM --platform=linux/amd64 oven/bun:1.1-alpine AS builder
WORKDIR /app/

# Install tools
RUN apk add --no-cache curl git

# Copy core files
COPY package.json tsconfig.json bun.lockb* ./

# Clean package.json
RUN sed -i '/"postinstall"/d' package.json

# Install dependencies
RUN bun install

# Copy source files (with existence checks)
RUN mkdir -p src/ public/ services/ types/
COPY ./src/ ./src/
RUN if [ -d ./public ]; then cp -r ./public/ ./public/; fi
RUN if [ -d ./services ]; then cp -r ./services/ ./services/; fi
RUN if [ -d ./types ]; then cp -r ./types/ ./types/; fi

# Create entry point
RUN echo "export * from './src/index';" > index.ts

# Build
RUN rm -rf dist/ && \
    mkdir -p dist/public/ && \
    bun x tsc --skipLibCheck

# Stage 2: Runtime
FROM --platform=linux/amd64 oven/bun:1.1-alpine
WORKDIR /app/
RUN apk add --no-cache curl

# Copy production files
COPY --chown=1000:1000 --from=builder /app/node_modules/ ./node_modules/
COPY --chown=1000:1000 --from=builder /app/dist/ ./dist/
COPY --chown=1000:1000 --from=builder /app/package.json ./
COPY --chown=1000:1000 --from=builder /app/public/ ./public/ 2>/dev/null || mkdir -p ./public/

# Environment
ENV PORT=3000 NODE_ENV=production BUN_ENV=production \
    AUGMENTOS_API_KEY="" AQI_TOKEN="" \
    PACKAGE_NAME="air-quality-app" \
    ENABLE_LOCATION_FALLBACK="true" \
    LOCATION_TIMEOUT_MS="10000" \
    DEFAULT_LAT="51.5074" DEFAULT_LON="-0.1278"

EXPOSE $PORT
USER 1000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:$PORT/health || exit 1
CMD ["bun", "dist/index.js"]