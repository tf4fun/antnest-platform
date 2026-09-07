# Build from the repository root:
#   docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
FROM rust:1.96-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnftables-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY runtimes/antnest-runtime/rust-toolchain.toml ./rust-toolchain.toml
RUN rustup show active-toolchain
COPY runtimes/antnest-runtime ./runtimes/antnest-runtime
COPY contracts/runtime ./contracts/runtime
WORKDIR /src/runtimes/antnest-runtime
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/runtimes/antnest-runtime/target \
    cargo fmt --check \
    && cargo clippy --locked --all-targets -- -D warnings \
    && cargo test --locked \
    && cargo build --locked --example managed-mcp-fixture \
    && cp target/debug/examples/managed-mcp-fixture /tmp/managed-mcp-fixture \
    && cargo build --locked --release \
    && cp target/release/antnest-runtime /tmp/antnest-runtime

FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 libnftables1 nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 1000 --home-dir /workspace --no-create-home agent \
	&& mkdir -p /workspace /skills \
	&& chown 1000:1000 /workspace \
	&& chmod 0555 /skills \
    && python --version \
    && node --version \
    && npm --version
COPY --from=build /tmp/antnest-runtime /usr/local/bin/antnest-runtime
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/antnest-runtime", "serve"]
