FROM golang:1.27.1-bookworm AS build

WORKDIR /src/services/edge-gateway
COPY modules/service-authentication /src/modules/service-authentication
COPY services/edge-gateway/go.mod services/edge-gateway/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/edge-gateway ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/edge-gateway ./cmd/edge-gateway

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/edge-gateway /usr/local/bin/edge-gateway
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/edge-gateway"]
