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

# Create .env file with default values
RUN echo "# Default environment variables\nPORT=3000\n" > .env

# Run the build script
RUN bun run build

# Verify the build output exists
RUN ls -la dist/

# Expose port
EXPOSE 3000

# Start the app from built output
CMD ["bun", "dist/index.js", "--hostname=0.0.0.0"]