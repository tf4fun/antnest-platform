FROM rust:1.98.1-bookworm AS build
WORKDIR /src
COPY modules/runtime-tunnel ./modules/runtime-tunnel
COPY tests/support/runtime-tunnel ./tests/support/runtime-tunnel
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/modules/runtime-tunnel/target,sharing=locked \
    cargo build --locked --release --manifest-path modules/runtime-tunnel/Cargo.toml --example readiness-peer \
    && cp modules/runtime-tunnel/target/release/examples/readiness-peer /tmp/readiness-peer
FROM debian:bookworm-slim
COPY --from=build /tmp/readiness-peer /usr/local/bin/readiness-peer
ENTRYPOINT ["/usr/local/bin/readiness-peer"]
