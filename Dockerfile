# Use Bun official image
FROM oven/bun:1.1

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Install dependencies
RUN bun install

# Run the build script to generate dist/index.js
RUN bun run build

# Expose port (optional: if you use 3000 or another)
EXPOSE 3000

# Start the app from built output
CMD ["bun", "dist/index.js"]
