FROM node:24-bookworm-slim AS build

WORKDIR /workspace/services/agent-acp-service

COPY services/agent-acp-service/package.json services/agent-acp-service/package-lock.json ./
RUN npm ci --ignore-scripts

COPY services/agent-acp-service/tsconfig.json services/agent-acp-service/tsconfig.build.json ./
COPY services/agent-acp-service/src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY services/agent-acp-service/package.json services/agent-acp-service/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build --chown=node:node /workspace/services/agent-acp-service/dist ./dist
COPY --chown=node:node services/agent-acp-service/migrations ./migrations

USER node
EXPOSE 8080

CMD ["node", "dist/main.js"]
