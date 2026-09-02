# Runtime UDP Tunnel Contract

Runtime uses one connected UDP socket to the private Runtime Egress endpoint.
The tunnel is a data-plane transport only: it has no HTTP handshake, WebSocket
subprotocol, authentication token, application session, heartbeat, or tracing
envelope.

Packet contract revision `1` is defined by `packet-contract.json`. One UDP
datagram contains exactly one complete inner IPv4 packet. UDP already
preserves message boundaries, so the payload has no Antnest marker, length,
batch header, Runtime identity, or generation field.

The current Runtime accepts only complete, unfragmented IPv4 TCP packets no
larger than the fixed 1400-byte inner MTU. The IPv4 total-length field must equal
the UDP payload length and the packet must contain a valid TCP header and data
offset. Empty datagrams, trailing bytes, UDP, IPv6, and fragmented inner packets
are rejected.

IPv4 options are carried opaquely when the IHL is structurally valid; neither
Runtime nor Egress interprets them. Supporting them is part of the current
contract, not a generation-specific capability.

Runtime accepts an outbound packet only when its inner source is the exact
Tunnel IPv4 assigned in RuntimeSpec. It accepts a response datagram only when
the inner destination is that same address. These checks prevent an untrusted
Agent process from selecting another Agent's Egress identity through forged TUN
packets.

Runtime Egress learns the return peer from each outbound UDP source address and
maps the inner flow to that peer. A response datagram contains the complete
return IPv4 packet and is written back to Runtime TUN. The current Agent always
initiates the inner TCP flow, so no registration protocol is required.

Before exposing Runtime readiness, Runtime sends one canonical TCP SYN from its
assigned Tunnel IPv4 and a dynamic source port (`49152..65535`) to the reserved
documentation endpoint `192.0.2.1:9`. It has no acknowledgement or payload and
uses only the SYN flag. Egress returns a local RST+ACK correlated by Tunnel
address, ports, and acknowledgement number. The request and response shape is
normative in `packet-contract.json`.

An active allocation with a closed Runtime attachment is represented inside
Egress as a probe-only route. It accepts only this canonical probe and never
writes it to TUN, creates a flow, or reaches an upstream. Every malformed or
near-miss packet remains fenced. An open attachment reaches the same local
response through the immutable special-use-address policy baseline. This is a
bounded packet-path liveness check, not Runtime identity, an additional tunnel
envelope, heartbeat, registration protocol, or claim of public connectivity.
Agent Controller must create the durable network allocation before starting the
Runtime.

Packet loss, duplication, and reordering retain ordinary IP semantics. Runtime
and Egress do not retransmit tunnel datagrams; inner TCP owns reliability and
congestion control. Runtime does not batch packets because a batch could exceed
the platform path MTU and introduce outer fragmentation.

The trusted Docker or Kubernetes network owns endpoint isolation. Egress maps
the validated inner source Tunnel IPv4 to the durable Agent allocation and its
current policy. The outer UDP peer is only an ephemeral return locator. Runtime
generation, token, and policy fields are deliberately absent from the packet.

UID routing, TUN setup, write deadlines, and process privileges are Runtime
implementation concerns and are specified by the Runtime architecture and
security documents. They are deliberately absent from this shared wire
contract.

There is one current tunnel contract and no legacy WebSocket compatibility
path. RuntimeSpec and the Egress network attachment carry the exact packet
contract revision. Runtime refuses to become ready when that revision is not
supported, so a mixed deployment fails during preparation instead of silently
dropping traffic.

An incompatible future packet change follows expand, migrate, contract: first
deploy an Egress release that serves the old and new revisions on distinct UDP
endpoints, then roll Runtime generations to the new endpoint and revision, and
only then remove the old decoder and endpoint. Packet bytes remain raw IP; the
revision is never added as a per-packet envelope. Any revision change updates
`packet-contract.json`, this document, and `packet-fixtures.json` before either
implementation. Both implementations consume the same machine-readable
contract and fixtures in admission tests. MCP never duplicates packet bytes or
tunnel state.
