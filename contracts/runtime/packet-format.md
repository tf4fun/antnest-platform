# Authenticated Runtime UDP Tunnel Contract

Packet revision 2 is `ANT2` + a 16-byte binary key ID + one unmodified WireGuard
message over UDP. The opaque ID is the decoded hex suffix of `rtk_<32 lowercase
hex>`. It selects a prepared context, not an Agent authentication claim.
The exact profile is BoringTun 0.7.1, Noise IKpsk2 with X25519, ChaCha20-Poly1305
and BLAKE2s. Protocol-owned handshake, session timers and replay checks must run
before plaintext enters the existing packet policy/flow engine. There is no raw
IPv4 or revision-1 decoder on this endpoint.

The authenticated context is bound by owner-managed registration to one Agent,
opaque Runtime revision, Tunnel IPv4 and independently generated endpoint keys
and PSK. A decrypted packet's source on uplink, or destination on downlink, must
match this exact allocation. Public prefix changes cannot borrow an Agent's
identity. Wrong key, unknown/retired context, malformed/tampered ciphertext,
duplicate and out-of-window data are dropped before policy/flow attribution.
Drops use aggregate metrics without packet content or victim-Agent labels.

Inner data is one complete, unfragmented IPv4 TCP packet, at most 1400 bytes.
IPv4 total length must equal the decoded inner packet length; options remain
opaque. Outer maximum data overhead is 20 prefix + 32 protocol + 15 padding
bytes, plus 28 IPv4/UDP bytes: at most 1495. Unsupported inner UDP/IPv6/fragments
retain the existing rejection rules. Handshake, cookie and keepalive messages
never reach TUN. Call the engine's pending-output drain and timers; do not write
another retransmission, nonce or replay implementation around it.

Closed attachments can process authenticated handshakes and only the canonical
SYN to `192.0.2.1:9` defined in packet-contract.json, returning its local correlated
RST+ACK. They never write external data to TUN or create a flow. RC registers the
generation context before starting compute, so this preparation does not need
an open attachment or a plaintext probe exception. Open additionally requires
the current outer Runtime IPv4 and exact prepared key ID in attachment CAS.

Initialize/Update/Enable issue new endpoint keypairs and a new 32-byte PSK.
Process restart retains the protected generation material and establishes fresh
ephemeral sessions; captured old encrypted data cannot enter the new session.
Opening a new key retires its predecessor and clears flows/conntrack under the
packet-output barrier. Release removes current/candidate keys and sessions.

For ownership, encrypted storage, root-only private volume delivery, rollback,
workload route privacy and service batches see
[Authenticated Runtime tunnel](../../docs/authenticated-runtime-tunnel.md).
The cryptographic protocol and replay mechanics follow the
[WireGuard specification](https://www.wireguard.com/protocol/); Antnest's only
outer addition is the opaque routing prefix above.
