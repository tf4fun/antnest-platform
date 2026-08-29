# Runtime Egress Architecture

## Model

The service has three concepts:

1. A **reservation** binds Agent, Runtime instance, generation, virtual IPv4,
   allocator epoch, and policy epoch.
2. A **tunnel session** binds one admitted Runtime boot and connection epoch to
   that reservation.
3. A **flow** is observed TCP state used for validation, limits, and cleanup;
   it is not business data.

Controller reservation calls are authoritative. Runtime tunnel tokens are
short lived and contain the complete signed reservation, allowing process-local
state to recover after restart without adding a database. Token recovery is
monotonic: an exact reservation is idempotent, a newer generation or allocator
epoch may advance state, and an older token is rejected.

## Data Path

```text
Runtime TUN -> binary WebSocket -> frame/identity checks -> shared Egress TUN
             -> Linux TCP stack, conntrack, nftables, NAT -> public network
public reply -> shared Egress TUN -> flow lookup -> binary WebSocket -> Runtime TUN
```

Only complete, unfragmented IPv4/TCP packets enter the tunnel. UDP, IPv6, and
unsupported packets are rejected at the Runtime boundary. DNS uses TCP through
the same packet path and terminates at the virtual resolver hosted here.

## Package Map

| Package | Responsibility |
| --- | --- |
| `control` | Reservation ordering and authoritative/recovery semantics |
| `tunnel` | Token verification, WebSocket admission, packet framing |
| `egress` | Reservation, flow, TUN, nftables, conntrack, and packet data plane |
| `dnsproxy` | DNS-over-TCP forwarding from the virtual resolver |
| `httpapi` | Internal reservation and readiness HTTP contract |
| `protocol` | Service-local wire DTO validation |

## Failure Semantics

- Readiness fails if TUN or DNS is unavailable.
- Losing a tunnel closes its endpoint and flow state; the reservation remains.
- Data-plane failure trips a circuit breaker and closes active endpoints.
- Reservation release applies a deny barrier and clears conntrack before reuse.
- No packet is forwarded without matching generation, connection, policy, and
  allocator epochs.
