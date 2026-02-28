# Pi Server Mode — Production Image
FROM node:22-slim

# Install Chromium for browser-based tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium env vars
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built server
COPY dist/server ./dist/server
COPY src/core ./src/core
COPY src/config ./src/config
COPY src/prompts ./src/prompts

# Default configuration
ENV PI_SERVER_PORT=18100
ENV PI_SERVER_BIND=auto
ENV PI_DATA_DIR=/data
ENV NODE_ENV=production

# Create data directory
RUN mkdir -p /data/sessions/transcripts /data/sessions/backups

EXPOSE 18100

# Health check
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:18100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-vm-modules", "dist/server/server/index.js"]
