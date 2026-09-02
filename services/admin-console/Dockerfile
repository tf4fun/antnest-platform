FROM node:24-bookworm-slim AS web-build

WORKDIR /web
COPY services/admin-console/web/package.json services/admin-console/web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY services/admin-console/web ./
RUN npm run build

FROM golang:1.25-bookworm AS go-build

WORKDIR /src
COPY services/admin-console/go.mod services/admin-console/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/admin-console ./
COPY --from=web-build /web/dist ./web/static
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/admin-console ./cmd/admin-console

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=go-build /out/admin-console /usr/local/bin/admin-console
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/admin-console"]
