FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY services/runtime-provider-docker/go.mod services/runtime-provider-docker/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/runtime-provider-docker ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/runtime-provider-docker ./cmd/runtime-provider-docker

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/runtime-provider-docker /usr/local/bin/runtime-provider-docker
ENTRYPOINT ["/usr/local/bin/runtime-provider-docker"]
