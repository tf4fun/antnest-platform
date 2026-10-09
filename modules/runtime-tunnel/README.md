# Runtime tunnel transport

Pure packet transport shared by Runtime and Egress. BoringTun 0.7.1 owns
WireGuard handshakes, authenticated encryption, session rotation and the bounded
1024-counter receive window. This module adds only the revision 2 routing prefix.
It has no storage, HTTP, lifecycle, policy or TUN ownership.

Callers must bind decrypted IPv4 source/destination to the selected Agent before
policy or flow creation, drive `tick` every 250 ms, and transmit network events.
Each peer holds at most 256 queued inner packets and eight protocol sessions.
Restart creates fresh ephemeral sessions; no packet counter is persisted.

Run `cargo test --locked --manifest-path modules/runtime-tunnel/Cargo.toml`.
See the [packet contract](../../contracts/runtime/packet-format.md) and
[delivery plan](../../docs/authenticated-runtime-tunnel.md).
