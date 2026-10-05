FROM golang:1.27.1-bookworm AS build
WORKDIR /src/services/runtime-controller
COPY modules/service-authentication /src/modules/service-authentication
COPY services/runtime-controller/go.mod services/runtime-controller/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/runtime-controller ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/runtime-controller ./cmd/runtime-controller

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/runtime-controller /usr/local/bin/runtime-controller
ENTRYPOINT ["/usr/local/bin/runtime-controller"]
