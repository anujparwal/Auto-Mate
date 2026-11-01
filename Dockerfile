FROM oven/bun:1.4.4-debian AS base
WORKDIR /app

# Install system dependencies required for headless Chromium on Debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy package descriptors and lockfile
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Install Playwright Chromium browser binary
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bun x playwright install --with-deps chromium

# Copy application source and assets
COPY src/ ./src/
COPY tools/ ./tools/
COPY ui/ ./ui/
COPY tsconfig.json ./
COPY bunfig.toml ./

# Default data directory for user vaults
RUN mkdir -p /data

# Default Railway container environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV AUTOMATE_HOSTED_DATA_DIR=/data

EXPOSE 8080

CMD ["bun", "run", "tools/run-hosted.ts"]
