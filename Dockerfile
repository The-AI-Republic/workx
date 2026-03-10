# Apple Pi Server Mode — Production Image
#
# Two deployment modes for browser automation:
#
# 1. Bundled Chrome (default): Chrome installed in image, works standalone
#    docker build -t applepi-server .
#
# 2. Slim (remote browser): No Chrome, connects to external browser pool
#    docker build --build-arg INSTALL_CHROME=false -t applepi-server-slim .
#    Then set CHROME_REMOTE_URL=http://chrome-pool:9222 at runtime

# Stage 1: Build the server bundle
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/ws-server/package.json packages/ws-server/package.json
RUN npm ci

COPY . .
RUN npx vite build --config vite.config.server.mts

# Stage 2: Production image
FROM node:22-slim

ARG INSTALL_CHROME=true

# Install Chromium if requested (adds ~300MB to image)
RUN if [ "$INSTALL_CHROME" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Skip Puppeteer's bundled Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Set CHROME_BIN only when Chrome is bundled
# For remote browser, set CHROME_REMOTE_URL at runtime instead
ENV CHROME_BIN=${INSTALL_CHROME:+/usr/bin/chromium}

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built server from builder stage
COPY --from=builder /app/dist/server ./dist/server

# Default configuration
ENV APPLEPI_SERVER_PORT=18100
ENV APPLEPI_SERVER_BIND=auto
ENV APPLEPI_DATA_DIR=/data
ENV NODE_ENV=production

# Credential encryption requires VITE_VAULT_SECRET at runtime:
#   docker run -e VITE_VAULT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") ...
# Without it, API key storage is disabled (server starts but keys won't persist).

# Create data directory
RUN mkdir -p /data/sessions/transcripts /data/sessions/backups

EXPOSE 18100

# Health check
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:18100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
