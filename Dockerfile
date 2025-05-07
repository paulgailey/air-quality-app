# Use the official Bun image
FROM oven/bun:1.1.4

WORKDIR /app

# Copy everything
COPY . .

# Install deps
RUN bun install --frozen-lockfile

# Build the app (update script if needed)
RUN bun run build

# Start the app
CMD ["bun", "dist/index.js"]