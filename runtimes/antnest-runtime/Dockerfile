# Build from the repository root:
#   docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
FROM rust:1.98.1-bookworm AS build
ARG CARGO_BUILD_JOBS=2
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnftables-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY runtimes/antnest-runtime/rust-toolchain.toml ./rust-toolchain.toml
RUN rustup show active-toolchain
COPY runtimes/antnest-runtime ./runtimes/antnest-runtime
COPY tests/integration/antnest-runtime ./tests/integration/antnest-runtime
COPY tests/integration/skill-registry/package-rules-v1.json ./tests/integration/skill-registry/package-rules-v1.json
COPY contracts/runtime ./contracts/runtime
WORKDIR /src/runtimes/antnest-runtime
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/runtimes/antnest-runtime/target,sharing=locked \
    cargo fmt --check \
    && cargo clippy --locked --all-targets -- -D warnings \
    && cargo test --locked \
    && cargo test --locked --example managed-mcp-fixture \
    && cargo build --locked --example managed-mcp-fixture \
    && cp target/debug/examples/managed-mcp-fixture /tmp/managed-mcp-fixture \
    && cargo build --locked --release \
    && cp target/release/antnest-runtime /tmp/antnest-runtime

FROM build AS build-e2e
ARG ANTNEST_RUNTIME_FEATURES
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/runtimes/antnest-runtime/target,sharing=locked \
    test -n "$ANTNEST_RUNTIME_FEATURES" \
    && cargo clippy --locked --all-targets --features "$ANTNEST_RUNTIME_FEATURES" -- -D warnings \
    && cargo test --locked --features "$ANTNEST_RUNTIME_FEATURES" \
    && cargo build --locked --release --features "$ANTNEST_RUNTIME_FEATURES" \
    && cp target/release/antnest-runtime /tmp/antnest-runtime-e2e

FROM node:24.21.0-bookworm-slim AS node

FROM python:3.14.7-slim-bookworm AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 libnftables1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN useradd --uid 1000 --home-dir /workspace --no-create-home agent \
	&& mkdir -p /workspace /skills \
	&& chown 1000:1000 /workspace \
	&& chmod 0555 /skills \
    && python --version \
    && node --version \
    && npm --version
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/antnest-runtime", "serve"]

FROM runtime-base AS e2e
ARG ANTNEST_RUNTIME_FEATURES
COPY --from=build-e2e /tmp/antnest-runtime-e2e /usr/local/bin/antnest-runtime
LABEL dev.antnest.runtime.test-features="${ANTNEST_RUNTIME_FEATURES}"
ENV ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true

FROM runtime-base AS release
COPY --from=build /tmp/antnest-runtime /usr/local/bin/antnest-runtime
LABEL dev.antnest.runtime.test-features=""
