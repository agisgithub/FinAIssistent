FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM dependencies AS verify
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node test ./test
COPY --chown=node:node config.docker.example.json compose.yaml Dockerfile ./
RUN mkdir -p /app/work && chown -R node:node /app/work
USER node
CMD ["npm", "test"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production CONFIG_FILE=/app/config.json
WORKDIR /app
COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node config.docker.example.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/health.mjs scripts/preflight.mjs scripts/telegram-info.mjs scripts/setup-docker.mjs ./scripts/
COPY --chown=node:node scripts/configure-ai.mjs ./scripts/
COPY --chown=node:node scripts/add-actual-base.mjs ./scripts/
RUN mkdir -p /data/actual && chown -R node:node /data
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 CMD ["node", "scripts/health.mjs"]
CMD ["node", "src/main.mjs"]
