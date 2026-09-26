FROM node:24.21.0-alpine AS ui-build

WORKDIR /app
COPY services/agent-ui/web/package*.json ./
RUN npm ci
COPY services/agent-ui/web/server/ ./server/
COPY services/agent-ui/web/src/ ./src/
COPY services/agent-ui/web/index.html services/agent-ui/web/tsconfig*.json services/agent-ui/web/vite*.ts ./
RUN npm run build:bridge && npm prune --omit=dev

FROM node:24.21.0-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY --from=ui-build --chown=node:node /app/package.json ./package.json
COPY --from=ui-build --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=ui-build --chown=node:node /app/server/dist/ ./server/dist/
COPY --from=ui-build --chown=node:node /app/dist/client/ ./dist/client/
COPY --from=ui-build --chown=node:node /app/dist/ssr/ ./dist/ssr/
USER node

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=2s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
