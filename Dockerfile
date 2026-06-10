# Stage 1: Build the React frontend
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Build the Node backend
FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
RUN npm run build

# Stage 3: Final Production Image
FROM node:20-bookworm-slim

# Install ffmpeg with hardware acceleration (NVENC) support built-in
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app/server

# Copy backend package files and install production dependencies
COPY --from=server-builder /app/server/package*.json ./
RUN npm install --production

# Copy compiled backend code
COPY --from=server-builder /app/server/dist ./dist

# Copy compiled frontend code to the public folder where the backend expects it
COPY --from=client-builder /app/client/dist ../public

# Set default environment variables
ENV PORT=8096
ENV NODE_ENV=production

# Expose the standard media server port
EXPOSE 8096

# Start the server
CMD ["node", "dist/index.js"]
