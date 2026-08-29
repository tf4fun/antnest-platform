FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY services/runtime-egress/go.mod services/runtime-egress/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/runtime-egress ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/runtime-egress ./cmd/runtime-egress

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates conntrack iproute2 nftables \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/runtime-egress /usr/local/bin/runtime-egress
ENTRYPOINT ["/usr/local/bin/runtime-egress"]
