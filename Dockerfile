FROM oven/bun:1.4.4-debian
WORKDIR /app

COPY package.json bun.lock ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Playwright installs the Chromium build and OS libraries matching its pinned dependency.
RUN bun install --frozen-lockfile --production \
    && bun x playwright install --with-deps chromium \
    && install -d -o bun -g bun -m 0700 /data

COPY src/ ./src/
COPY tools/ ./tools/
COPY ui/ ./ui/
COPY tsconfig.json bunfig.toml ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV AUTOMATE_HOSTED_DATA_DIR=/data
# Mounted volumes must be writable by uid 1000. The host must allow Chromium user namespaces.
# Chromium sandboxing remains enabled; incompatible platforms must not silently disable it.
USER bun
EXPOSE 8080
CMD ["bun", "run", "tools/run-hosted.ts"]
