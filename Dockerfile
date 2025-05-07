# Use Bun official image
FROM oven/bun:1.1

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies
RUN bun install

# Copy the rest of the application code
COPY . .

# Run the build script to generate dist/index.js
RUN bun run build

# Verify the build output exists
RUN ls -la dist/ || echo "Build failed - dist directory doesn't exist or is empty"

# Expose port
EXPOSE 3000

# Start the app from built output
CMD ["bun", "dist/index.js"]