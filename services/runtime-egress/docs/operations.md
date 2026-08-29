# Runtime Egress Operations

## Privileges

The container requires `NET_ADMIN`, `/dev/net/tun`, and the `ip`, `nft`, and
`conntrack` binaries. It must not receive the Docker socket. Runtime Controller
and Docker Provider need none of these network privileges.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTNEST_RUNTIME_TOKEN_SECRET` | yes | none | At least 32 bytes shared with Controller for tunnel tokens |
| `ANTNEST_EGRESS_LISTEN` | no | `:8081` | Trusted Controller reservation API |
| `ANTNEST_EGRESS_RUNTIME_LISTEN` | no | `:8092` | Runtime packet tunnel listener |
| `ANTNEST_RUNTIME_TUNNEL_CIDR` | no | `100.64.0.0/10` | Virtual Runtime address pool |
| `ANTNEST_RUNTIME_DNS_IPV4` | no | `100.64.0.1` | Virtual DNS endpoint |
| `ANTNEST_RUNTIME_DNS_UPSTREAM` | no | `1.1.1.1:53` | DNS-over-TCP upstream |

`/healthz` reports process liveness. `/readyz` additionally requires the TUN
data plane and DNS listener. Reservations are intentionally process-local;
Runtime reconnect tokens reconstruct them after restart.
