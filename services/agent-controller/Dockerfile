FROM golang:1.27.1-bookworm AS build
WORKDIR /src/services/agent-controller
COPY modules/service-authentication /src/modules/service-authentication
COPY modules/secret-encryption /src/modules/secret-encryption
COPY services/agent-controller/go.mod services/agent-controller/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/agent-controller ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/agent-controller ./cmd/agent-controller

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/agent-controller /usr/local/bin/agent-controller
RUN mkdir -p /home/antnest && chown 65532:65532 /home/antnest
ENV USER=antnest HOME=/home/antnest
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/agent-controller"]
