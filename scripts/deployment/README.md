# Development network transports

These two small Node built-in transports implement the infrastructure decisions
in the [purpose-network contract](../../contracts/platform/development-networks.md).
They have passed 17 native component tests and 21 isolated Docker protocol,
interface and shutdown checks. Compose wiring passed 43 local configuration/HTTP
checks and 51 actual production-service startup/mount/diagnostic/OTLP/normal-stop
checks, with owned resources cleaned and retained Docker identities unchanged.
Final platform integration remains pending in the
[rollout ledger](../../contracts/platform/service-authentication-rollout.json).
They are deployment plumbing with no domain service identity or credentials.

`diagnostic-relay.mjs` derives its seven immutable routes from the machine
contract and `ANTNEST_SERVICE_NETWORK_PREFIX`. It binds only the diagnostic
ingress IP and streams opaque bytes to fixed literal purpose IPs. Authentication,
caller context and TLS stay with the receiving service. It does not inspect
requests, inject authority, resolve request-selected destinations or write logs
containing payloads. The 64-connection budget covers all listeners; 64 KiB stream
high-water marks provide backpressure, connection establishment is bounded by
five seconds and idle connections by five minutes. Half-close responses remain
intact, including an 8 MiB slow-reader test.

`runtime-telemetry-ingress.mjs` uses that prefix for the fixed Jaeger observation
address and `ANTNEST_RUNTIME_OTLP_INGRESS_IPV4` for its management bind (default
`172.30.255.4`). The supported surface is POST on the three exact OTLP paths,
with no query strings or proxy/upgrade handshakes. It buffers and checks an
at-most-8-MiB wire body before opening the collector connection. It caps collector
responses at 1 MiB and simultaneous exchanges at eight, with an absolute
15-second exchange deadline. Compression is not decoded or transformed here;
the wire-byte bound applies before collector decoding. Only content type and
content encoding are forwarded in either direction. CCT, authorization, cookies,
redirects and claimed identities are not forwarded.

Both commands validate configuration before binding. Invalid prefix/bind or
startup failures emit only a fixed classification. SIGINT/SIGTERM stop accepting
work, cancel active connections/exchanges, clear owned timers and close all
listeners. No request body, credential, upstream response or filesystem error
is logged. The intended containers are UID/GID 65532, read-only and capability
free, with only these public scripts and their public machine contract mounted.
Neither transport receives Docker access, key/token mounts or workspace/Skill
volumes. OTLP has no host port; diagnostics require the explicit debug overlay.

Run the owning component gates from the repository root with the selected Node:

```sh
make test-deployment-transports
make e2e-deployment-transports
make test-deployment-wiring
make e2e-deployment-wiring
```

The Docker gate uses temporary source-mounted Node containers and protocol peers
on private owned subnets. A token-checking HTTP fixture verifies byte preservation
and absence of injected authority; a collector fixture verifies OTLP-only
forwarding. It checks management/observation interface rejection and normal
SIGINT/SIGTERM termination. It removes only its labelled resources and verifies
retained container/network/volume identities are unchanged. These are component
tests, **not** evidence for actual service authorization, Jaeger acceptance or the
complete login/lifecycle/Skill workflow; those require final integration after
Compose cutover.
