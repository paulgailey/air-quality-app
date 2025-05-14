# Stage 1: Build
FROM --platform=linux/amd64 ghcr.io/oven/bun:1.1-alpine AS builder
WORKDIR /app

# Install curl for debugging (optional)
RUN apk add --no-cache curl

# Copy package files with verification
COPY package.json .
RUN [ -f bun.lockb ] || bun install --frozen-lockfile
COPY bun.lockb .
RUN bun install --production

# Copy and build source
COPY . .
RUN bun run build

# Stage 2: Runtime
FROM --platform=linux/amd64 ghcr.io/oven/bun:1.1-alpine
WORKDIR /app

# Copy production assets with proper permissions
COPY --chown=1000:1000 --from=builder /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/dist ./dist
COPY --chown=1000:1000 --from=builder /app/package.json .

# Railway-ready config
ENV PORT=3000 \
    NODE_ENV=production \
    BUN_ENV=production
EXPOSE $PORT
USER 1000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:$PORT/health || exit 1
CMD ["bun", "dist/index.js"]