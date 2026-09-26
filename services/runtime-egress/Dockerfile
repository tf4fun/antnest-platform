FROM rust:1.98.1-bookworm AS build
ARG CARGO_BUILD_JOBS=2
WORKDIR /src
COPY services/runtime-egress ./services/runtime-egress
COPY tests/integration/runtime-egress ./tests/integration/runtime-egress
COPY contracts/runtime ./contracts/runtime
COPY contracts/egress ./contracts/egress
WORKDIR /src/services/runtime-egress
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/services/runtime-egress/target \
    cargo fmt --all --check \
    && cargo clippy --locked --all-targets -- -D warnings \
    && cargo test --locked \
    && cargo build --locked --release \
    && cp target/release/antnest-runtime-egress /tmp/runtime-egress

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates conntrack curl iproute2 nftables procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /tmp/runtime-egress /usr/local/bin/runtime-egress
ENTRYPOINT ["/usr/local/bin/runtime-egress"]
