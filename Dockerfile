# Polymarket Reverse Arbitrage Bot - Production Dockerfile
FROM node:22-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# ---------- Build stage ----------
FROM base AS builder

COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config

RUN npm run build && npm prune --omit=dev

# ---------- Frontend build ----------
FROM base AS frontend-builder

WORKDIR /app
COPY config ./config
COPY src/strategy ./src/strategy
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---------- Runtime stage ----------
FROM base AS runtime

# Create non-root user
RUN addgroup -g 1001 -S botuser && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G botuser botuser

# Copy built backend
COPY --from=builder --chown=botuser:botuser /app/dist ./dist
COPY --from=builder --chown=botuser:botuser /app/node_modules ./node_modules
COPY --from=builder --chown=botuser:botuser /app/package.json ./

# Copy built frontend (served by backend at /dashboard)
COPY --from=frontend-builder --chown=botuser:botuser /app/dist/dashboard/public ./dist/dashboard/public

# Copy config presets (read-only at runtime)
COPY --chown=botuser:botuser config/presets ./config/presets

# Data directory for SQLite + bot-settings.json (mounted as volume)
RUN mkdir -p /app/data && chown -R botuser:botuser /app/data

USER botuser

EXPOSE 3105

ENV NODE_ENV=production
ENV ENABLE_DASHBOARD=true
ENV DASHBOARD_PORT=3105

# Health check (dashboard root endpoint)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3105/ || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]