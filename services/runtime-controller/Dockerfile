FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/runtime-controller/go.mod services/runtime-controller/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/runtime-controller ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/runtime-controller ./cmd/runtime-controller
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/legacy-backup-export ./cmd/legacy-backup-export
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/legacy-backup-attest ./cmd/legacy-backup-attest

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/runtime-controller /usr/local/bin/runtime-controller
COPY --from=build /out/legacy-backup-export /usr/local/bin/legacy-backup-export
COPY --from=build /out/legacy-backup-attest /usr/local/bin/legacy-backup-attest
ENTRYPOINT ["/usr/local/bin/runtime-controller"]
