# Stage 1: Build
FROM oven/bun:1.1-slim AS builder
WORKDIR /app

# Copy package files
COPY package.json .
COPY bun.lockb .
RUN bun install --production

# Copy and build source
COPY . .
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:1.1-slim
WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .

# Railway configuration
ENV PORT=3000
EXPOSE $PORT
CMD ["bun", "dist/index.js"]