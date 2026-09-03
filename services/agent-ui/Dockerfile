FROM node:24-alpine AS web-build

WORKDIR /src
COPY services/agent-ui/web/package*.json ./
RUN npm ci
COPY services/agent-ui/web/ ./
RUN npm run build

FROM nginx:1.29-alpine

COPY services/agent-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /src/dist/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=2s --retries=5 CMD wget -q -O - http://127.0.0.1:8080/status >/dev/null || exit 1
