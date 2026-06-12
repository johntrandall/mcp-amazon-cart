# syntax=docker/dockerfile:1.6
#
# mcp-amazon-cart — Amazon Cart MCP server (Patchright + Xvfb + x11vnc)
#
# Two-stage build:
#   1. build stage — node:20-bookworm, compiles TypeScript to dist/
#   2. runtime stage — node:20-bookworm-slim + chromium-deps + Xvfb + x11vnc + supervisor
#
# Pattern source: ~/dev/browser-pool-stealth-patchright/Dockerfile (P1s tier, ADR-020).
# Adaptations:
#   - Two-stage instead of one (we have our own TypeScript src/ to compile;
#     P1s only installs an npm package and never compiles anything).
#   - Adds x11vnc + a /root/.vnc/passwd file built from $VNC_PASSWORD at
#     container start (NOT at build time — we never want VNC password baked
#     into an image layer).
#   - Internal HTTP port is fixed to 3000 (madebydia's Express server default,
#     Track 3 preserves this); compose maps host 8937/8938 → container 3000.
#   - patchright is the runtime browser driver because Track 3 ported off
#     Puppeteer to Patchright Playwright — same substrate as P1s but with a
#     dedicated browser context per stack (no cross-cookie contamination).
#
# Memory tuning (Verified — copied from P1s lesson, see web-p1s-stealth-pool
# SKILL.md "Container can survive Xvfb death silently" row 2026-05-27):
#   - NODE_OPTIONS=--max-old-space-size=2048 caps V8 old-space at 2 GiB.
#   - compose mem_limit: 3g leaves headroom for Chrome RSS + Xvfb + x11vnc.
#   - Direct `exec node` in entrypoint (NOT npm start) so V8 OOM exits the
#     container cleanly and Docker's restart_policy gives us a fresh /tmp.

# ────────────────────────────────────────────────────────────────────────
# Stage 1 — build
# ────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS build

WORKDIR /app

# Install deps with the full toolchain (TypeScript needs devDependencies for
# tsc). We copy package.json + package-lock.json (if present) first to
# maximise Docker layer-cache reuse across source-only edits.
COPY package.json ./
COPY package-lock.json* ./

# npm ci is preferred when a lockfile exists; fall back to npm install
# (madebydia ships no lockfile — gitignore'd). --no-audit/--no-fund cut
# ~10s off build time.
RUN if [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund ; \
    else \
        npm install --no-audit --no-fund ; \
    fi

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# System dependencies:
#   - Chromium/Chrome runtime libs (standard Playwright/Chrome list, copied
#     verbatim from P1s — verified working against amazon.com 2026-05-13)
#   - Xvfb so Chrome runs headed (Patchright's recommended stealth posture)
#   - x11vnc + supervisor (new vs P1s): enables first-run Amazon login over
#     VNC and re-auth/CAPTCHA resolution without docker cp gymnastics
#   - tini as PID 1 so we reap zombies (Chrome leaves many)
#   - fonts-liberation so rendered pages look like a real desktop
#   - curl for the healthcheck
#   - procps gives us `ps` for entrypoint diagnostics
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg tini xvfb x11vnc \
        fonts-liberation procps \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        libatspi2.0-0 libx11-xcb1 libxshmfence1 libglib2.0-0 \
        libdbus-1-3 libexpat1 libuuid1 \
        xauth x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled JS, runtime deps (pruned to production), and package metadata
# from the build stage. We do NOT copy src/ — the runtime image only needs
# the compiled output.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Track 3 should depend on `patchright` and `playwright` (or `playwright-core`).
# Patchright fetches its browser binary via a CLI invocation; we run it
# explicitly in the RUNTIME stage so the binary lands in the runtime image,
# not the build image (the build stage gets discarded). PATCHRIGHT_BROWSERS_PATH
# defaults to ~/.cache/ms-playwright; we pin it so the entrypoint can find it
# deterministically across user/uid changes.
#
# `--with-deps chrome` installs system Chrome alongside; we already have the
# lib*-set above, so this is a belt-and-suspenders pass.
ENV PATCHRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p "$PATCHRIGHT_BROWSERS_PATH" \
    && npx --prefix /app patchright install --with-deps chrome \
    || echo "WARN: patchright install returned non-zero (may indicate package not in dependencies — verify Track 3 adds patchright to package.json)"

# Copy entrypoint + supervisor script. Both must be 0755.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default env. The values that MUST be supplied at runtime (AUTH_TOKEN,
# VNC_PASSWORD, AMAZON_DOMAIN per stack, PUSHOVER_*) are declared in the
# compose Env array — declaring them here would let stale build-time values
# leak into the image.
ENV NODE_OPTIONS="--max-old-space-size=2048" \
    DISPLAY=:99 \
    DISPLAY_NUM=99 \
    MCP_HTTP_PORT=3000 \
    VNC_PORT=5900 \
    USER_DATA_DIR=/data/user-data \
    HEADLESS=true

# The MCP HTTP port is fixed at 3000 inside the container (madebydia's
# default; Track 3 preserves it). Compose maps host 8937/8938 → 3000.
# VNC is fixed at 5900 inside; compose maps host 5937/5938 → 5900.
EXPOSE 3000 5900

# Healthcheck: hit /health (no auth required per madebydia's Express setup
# — confirm Track 3 left this route unauth'd). If Track 3 moved /health
# behind the bearer gate, this healthcheck will need to add Authorization;
# tracked in the briefing's "sharp edges" list.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS --max-time 4 "http://127.0.0.1:${MCP_HTTP_PORT:-3000}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
