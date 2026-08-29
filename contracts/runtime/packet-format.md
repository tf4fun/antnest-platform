# Runtime UDP Tunnel Contract

Runtime uses one connected UDP socket to the private Runtime Egress endpoint.
The tunnel is a data-plane transport only: it has no HTTP handshake, WebSocket
subprotocol, authentication token, application session, heartbeat, or tracing
envelope.

One UDP datagram contains exactly one complete inner IPv4 packet. UDP already
preserves message boundaries, so the payload has no Antnest marker, length,
batch header, Runtime identity, or generation field.

The current Runtime accepts only complete, unfragmented IPv4 TCP packets no
larger than the fixed 1400-byte inner MTU. The IPv4 total-length field must equal
the UDP payload length and the packet must contain a valid TCP header and data
offset. Empty datagrams, trailing bytes, UDP, IPv6, and fragmented inner packets
are rejected.

Runtime Egress learns the return peer from each outbound UDP source address and
maps the inner flow to that peer. A response datagram contains the complete
return IPv4 packet and is written back to Runtime TUN. The current Agent always
initiates the inner TCP flow, so no registration protocol is required.

Packet loss, duplication, and reordering retain ordinary IP semantics. Runtime
and Egress do not retransmit tunnel datagrams; inner TCP owns reliability and
congestion control. Runtime does not batch packets because a batch could exceed
the platform path MTU and introduce outer fragmentation.

The trusted Docker or Kubernetes network owns endpoint isolation. Egress does
not need Agent identity to forward the current unrestricted data plane. A future
per-Agent policy model must introduce an explicit contract rather than infer
identity from packet contents.

Runtime does not modify the root Supervisor's platform main routing table.
Instead, it installs a dedicated policy-routing table for locally generated
UID 1000 traffic. That table has TUN as its only usable default path and a
terminal unreachable route that prevents fallback to the platform main table.
Root-owned MCP replies, Egress UDP, and OTLP therefore remain direct, while all
Agent Executor traffic enters the Agent Egress data plane without maintaining
an Antnest CIDR allowlist.

Runtime applies a bounded TUN write deadline to each return packet. Invalid
datagrams terminate the affected Runtime tunnel rather than being injected into
the kernel protocol stack.

There is one current tunnel contract and no legacy WebSocket compatibility path.
Any incompatible packet change must update Runtime, Egress, this contract, and
`packet-fixtures.json` atomically. Runtime tests consume those language-neutral
accepted/rejected fixtures directly. MCP never duplicates packet bytes or
tunnel state.
