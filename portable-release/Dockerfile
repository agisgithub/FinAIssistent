FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM dependencies AS verify
COPY src ./src
COPY skills ./skills
COPY web ./web
COPY migrations ./migrations
COPY scripts ./scripts
COPY test ./test
COPY portable ./portable
COPY config.docker.example.json compose.yaml compose.portable.yaml Dockerfile ./
RUN mkdir -p /app/work && chown -R node:node /app
USER node
CMD ["npm", "test"]

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production CONFIG_FILE=/app/config.json
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY config.docker.example.json ./
COPY src ./src
COPY web ./web
COPY migrations ./migrations
COPY scripts/health.mjs scripts/preflight.mjs scripts/telegram-info.mjs scripts/setup-docker.mjs ./scripts/
COPY scripts/configure-ai.mjs ./scripts/
COPY scripts/add-actual-base.mjs ./scripts/
COPY scripts/run-classification.mjs ./scripts/
COPY scripts/skill.mjs ./scripts/
COPY scripts/dashboard-operator.mjs ./scripts/
COPY skills ./skills
RUN mkdir -p /data/actual && chown -R node:node /app /data
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 CMD ["node", "scripts/health.mjs"]
CMD ["node", "src/main.mjs"]
