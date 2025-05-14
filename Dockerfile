# Stage 1: Build
FROM --platform=linux/amd64 oven/bun:1.1-alpine AS builder
WORKDIR /app/

# Install curl for debugging and git for potential dependencies
RUN apk add --no-cache curl git

# Copy package files first (with trailing slashes)
COPY package.json ./
COPY tsconfig.json ./
COPY bun.lockb* ./

# Remove the postinstall script from package.json before installing
RUN sed -i '/"postinstall"/d' package.json

# Install dependencies (including dev dependencies for TypeScript compilation)
RUN bun install

# Copy only the core application files (with trailing slashes and error suppression)
COPY ./src/ ./src/
COPY ./types/ ./types/ 2>/dev/null || true
COPY ./services/ ./services/ 2>/dev/null || true
COPY ./public/ ./public/ 2>/dev/null || true

# Create types directory structure if it doesn't exist
RUN mkdir -p ./types/

# Create a simplified entry point that matches the one we need
RUN echo "// Main application entry point export * from './src/index';" > index.ts

# List files for verification
RUN find ./src/ -type f | sort

# Build the application (only including the necessary files)
RUN rm -rf dist/ && \
    mkdir -p dist/public/ && \
    bun x tsc --skipLibCheck

# Stage 2: Runtime
FROM --platform=linux/amd64 oven/bun:1.1-alpine
WORKDIR /app/

# Install required runtime dependencies
RUN apk add --no-cache curl

# Copy production assets with proper permissions (all with trailing slashes)
COPY --chown=1000:1000 --from=builder /app/node_modules/ ./node_modules/
COPY --chown=1000:1000 --from=builder /app/dist/ ./dist/
COPY --chown=1000:1000 --from=builder /app/package.json ./
COPY --chown=1000:1000 --from=builder /app/public/ ./public/

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