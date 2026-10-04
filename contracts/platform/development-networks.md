# Development purpose networks

This deployment contract belongs to [#32](https://github.com/tf4fun/antnest-platform/issues/32).
The [machine contract](development-network-contract.json) is frozen at version 1;
Compose wiring and full-platform admission remain **pending**. The
[deployment transports](../../scripts/deployment/README.md) separately passed
17 native and 21 isolated Docker component checks; those do not admit the full
deployment topology or actual business flows.
It complements the [credential contract](development-authentication.md) and
[platform authentication rules](service-authentication.md). Token/CCT identity,
route allowlists and business ownership remain unchanged.

## Verified deployment constraints

The isolated [Docker observation](../../tests/integration/deployment/purpose-listener-docker.mjs)
established these results on the development Engine:

| Listener and container networks                                  | Primary health | Host publication                            |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------- |
| Internal purpose network only, purpose-address listener          | Ready          | No mapped host endpoint                     |
| Internal purpose plus outbound network, purpose-address listener | Ready          | Mapped endpoint cannot reach listener       |
| Same networks, individually tagged listeners on both addresses   | Ready          | Host endpoint reaches the outbound listener |

The probe removes its own labelled containers/networks and compares retained
container, network and volume identities before and after. This is evidence for
the deployment decision, not full-platform or route authorization acceptance.

Consequently Gateway has a dedicated ingress interface. Internal services keep
their purpose-address listeners; explicitly requested diagnostics use a bounded
TCP relay. Do not restore wildcard listeners to make old port mappings work.

## Addresses and destinations

`ANTNEST_SERVICE_NETWORK_PREFIX` defaults to the literal IPv4 prefix `10.241.0`.
Each machine-contract `subnet_suffix` defines one `/28`; each member gets its
listed last octet. All fixed peers, including init/diagnostic peers, use fixed
addresses so automatic allocation cannot take an absent receiver's address.
Use a different free prefix for a separate deployment and retain that prefix
with its deployment settings. Overlapping/invalid subnets are deployment errors;
never disconnect or remove another project's network to make room.

| Network                | Fixed peers and purpose                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `edge`                 | Gateway, Console, UI, ACP workspace, Registry source client and optional diagnostics |
| `controller-clients`   | Controller, Gateway, Console, UI, ACP and optional diagnostics                       |
| `controller-acp`       | Controller and ACP's separate control listener                                       |
| `controller-runtime`   | Controller, RC and optional diagnostics                                              |
| `identity-clients`     | Identity and its authenticated consumers, plus optional diagnostics                  |
| `registry-clients`     | Registry, Console, Controller, RC and ACP                                            |
| `temporal-clients`     | Temporal, Controller, namespace initialization and optional diagnostics              |
| `observability`        | Jaeger and exporters; optional diagnostic relay reaches the query UI here            |
| `gateway-ingress`      | Gateway only; noninternal, default gateway priority 1                                |
| `diagnostic-ingress`   | Explicit diagnostic relay only; noninternal, default gateway priority 1              |
| `postgres-diagnostics` | PostgreSQL and optional diagnostic relay; internal                                   |
| `control`              | Existing private Controller/Egress control subnet                                    |

The seven owner database networks are internal and retain independently
authenticated PostgreSQL roles/databases. A shared development PostgreSQL
container does not permit cross-service database reads. The owning initialization
jobs join only their corresponding database networks.

Identity OIDC, Controller model discovery, ACP model inference and Egress
forwarding each have their own noninternal outbound network. They do not expose
business listeners there. Provider fixtures may join the explicitly selected
Controller/ACP test networks; they are not default deployment consumers.

Every workload destination uses a canonical receiver name mapped through
`extra_hosts` to that receiver's **listener purpose address**. Docker DNS for a
multihomed peer must not select its observation, database or outbound interface.
ACP uses the already declared `agent-acp-workspace` and `agent-acp-control`
aliases. Only `apply-execution-snapshot` and `settle-agent` use the control alias.
The contract tests derive all 23 current caller/receiver pairs from the owning
catalogs, and verify both network membership and destination selection.

The existing Controller/Egress and Runtime management subnet settings remain
separate from the `/28` prefix. Management reserves fixed infrastructure addresses
outside its dynamic allocation range, default `172.30.255.128/25` within
`172.30.255.0/24`. A changed management subnet requires matching fixed-address
and dynamic-range settings. Health follows the configured purpose address;
RC/Egress keep their separate loopback readiness listeners.

## Runtime telemetry exception

Jaeger leaves Runtime management completely: neither its query/UI nor its
collector listener is a management member. Business listeners, diagnostic
transport and credentials also remain outside management.

The current Runtime [destination validator](../../runtimes/antnest-runtime/src/telemetry.rs)
requires HTTP OTLP at a literal IPv4 address inside its direct platform network.
Moving Jaeger without providing that destination would silently break Runtime
telemetry. Version 1 therefore adds one **explicit infrastructure exception** to
the earlier RC/ACP/Egress/Runtime membership rule: `runtime-telemetry-ingress`,
default management address `.4:4318`, also joins observability.

This process only forwards POST bodies for the three exact OTLP paths to one
fixed Jaeger destination. Query strings, other methods/paths and arbitrary
destinations are rejected. The wire body is capped at 8 MiB, responses at 1 MiB,
concurrency at eight and each exchange at 15 seconds. Request forwarding keeps
only `content-type` and `content-encoding`; it never forwards authorization,
caller-context, cookies or claimed identity. It is data ingestion with no
business authority. Trace content is not proof of caller identity.

Run the transport nonroot, read-only and without capabilities, credentials,
workspace/Skill volumes or host ports. Normal shutdown closes pending upstream
exchanges. Final network probes must prove that management reaches only the
fixed ingestion surface and cannot use it to reach Jaeger's query/control APIs,
other destinations or business services. The helper is deployment plumbing,
not a new domain service or a change to the Runtime authentication protocol.

## Explicit host diagnostics after network cutover

`diagnostic-relay` is off by default (`diagnostics` profile) and has **no base
host publications**, even if that profile is selected. `compose.debug.yaml`
explicitly enables it and maps only seven fixed ports on `127.0.0.1`. The host
environment names/defaults in the [port contract](development-authentication-contract.json)
remain the same. Its logical `target` remains the backend service port; the
machine network contract supplies the relay listener and fixed backend address.
For example host RC port 58080 reaches relay port 58080, then RC purpose port 8080. No control, health or Runtime MCP port is published.

The relay forwards opaque TCP bytes, including the original token/CCT or TLS
exchange, without credentials of its own. It has at most 64 connections,
64 KiB stream high-water marks, a five-second connect timeout and a five-minute
idle timeout. It has no CONNECT API, dynamic destination selection, request
logging or protocol interpretation. Backpressure and normal shutdown bound
buffers and close all owned sockets. A failed backend fails that connection;
it must not select a different target.

This contract supersedes the intermediate debug overlay's direct backend
publications **when network cutover is implemented**. At that point product
`compose.stage3.yaml` no longer selects diagnostic exposure by file order;
debug is always an explicit opt-in. Test entry points requiring only dependency
diagnostics must use an explicit test override of the relay's publications.
Startup/shutdown retain exactly the same ordered files, profiles, environment
and project. Neither overlay changes workload/CCT rules or enables debug Skill
learning. Dependency-only tooling must not start application workloads or
generate/mount placeholder credentials.

## Admission order

1. Freeze this contract and its catalog-derived checks.
2. Test and admit the two deployment transports, then wire Compose addresses,
   destinations, key/token mounts, user IDs and dependency tooling. Recheck
   actual Gateway and diagnostic reachability after binding the real services.
3. Run final cross-service security probes on **every** joined network, followed
   by actual login/workspace, lifecycle/rebuild and Skill flows. Preserve normal
   shutdown and retained Docker resources.

The [rollout ledger](service-authentication-rollout.json) retains intermediate
port and standalone transport evidence separately. Contract tests and fixture
listeners do not complete
steps 2 or 3, and this document does not claim they have passed.
