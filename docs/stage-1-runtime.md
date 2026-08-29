# Stage 1 Runtime

> **Transition notice.** The Rust Runtime now exposes MCP 2026-07-28 and
> `/status`; the earlier Go Controller, Egress, and Docker Provider remain
> historical prototypes until their own service phases adopt the new
> RuntimeSpec. The current Runtime contract is
> [`../contracts/runtime/contract.json`](../contracts/runtime/contract.json).
> No compatibility layer is maintained.

Stage 1 establishes four explicit Runtime components: Go Runtime Controller,
Go Runtime Egress, Go Docker Runtime Provider, and the Rust per-Agent Runtime. It
must be usable without PocketBase, Agent Controller, ACP Service, Skill Registry,
Channel, or a Web UI.

This document owns cross-service invariants and Stage 1 acceptance. Service
internals and operating details are canonical in:

- [`../services/runtime-controller/README.md`](../services/runtime-controller/README.md)
- [`../services/runtime-egress/README.md`](../services/runtime-egress/README.md)
- [`../services/runtime-provider-docker/README.md`](../services/runtime-provider-docker/README.md)
- [`../runtimes/antnest-runtime/README.md`](../runtimes/antnest-runtime/README.md)
- [`../contracts/README.md`](../contracts/README.md)

## Ownership And Boundaries

1. `runtime-controller` owns Runtime desired state, generations, lifecycle
   operations, Runtime admission, reconciliation, and Work dispatch.
2. `runtime-egress` owns privileged packet transport, DNS, and generation-bound
   egress reservations.
3. `runtime-provider-docker` owns only Docker container and volume effects.
4. `antnest-runtime` owns the four MCP tools and their process/file side effects
   inside one Agent container. Runtime-local call serialization is deferred.
5. PostgreSQL stores only reconciliation facts. It does not store Prompt, Run,
   Memory, Skill, Channel, or Agent business records.
6. Internal HTTP APIs trust callers on the Compose control network and
   perform no end-user authentication.
7. Runtime containers are not attached to the control or egress network. They
   join only the internal Runtime management network, where they can reach the
   Controller and Egress fixed advertised addresses, plus their TUN data path.

## Stable Invariants

1. `agent_id` is the stable Runtime, container, and workspace identity.
2. Runtime generations are positive and monotonically increasing per Agent.
3. A repeated `(operation kind, agent_id, Idempotency-Key)` returns the original
   operation. Reusing that key for different input returns `409`.
4. A failed Runtime instance is replaced with a fresh container and network
   namespace. The replacement keeps the same generation when RuntimeSpec is
   unchanged; only a RuntimeSpec change creates a new generation.
5. Controller activates a candidate only after `/status` identity verification
   and MCP `tools/list` succeed.
6. A network mode change creates a replacement generation because network mode
   is immutable RuntimeSpec input.
7. Remote process/file effects report `completed`, `not_started`, or `unknown`.
   The Controller never silently retries an `unknown` side effect.
8. Docker Runtime Provider is the only Docker socket owner. Antnest Runtime has
   container-local `NET_ADMIN` and `/dev/net/tun` only for its own namespace;
   Runtime Egress owns Egress-side packet processing. Controller has neither.
9. Only one non-terminal lifecycle operation exists per Runtime generation.
   Pending intent may be replaced and becomes `superseded`; once durably
   claimed as `running` or observed as `unknown`, it must converge before a new
   lifecycle command is accepted.

## Lifecycle

All lifecycle mutations return `202 Accepted` with a durable operation. The
caller reads `/internal/v1/runtime-operations/{operation_id}` until the
operation reaches a terminal state.

| Command | Desired result | Container | Workspace |
| --- | --- | --- | --- |
| Prepare | current generation Ready | running | retained/created |
| Stop | Stopped | stopped | retained |
| Prepare after Stop | Ready | recreated | retained |
| Retire | Retired | removed | retained |
| Prepare after Retire | new generation Ready | recreated | retained |
| Purge | Purged | removed | removed |

Provider dispatch failures use three-state effect semantics. A known
not-dispatched failure is terminal and visible on Runtime and operation state.
An ambiguous transport result becomes `unknown` and is observed again after a
bounded delay. Startup recovery scans PostgreSQL, while the in-memory queue is
only a low-latency hint.

## Runtime Status And Tools

Runtime Provider injects immutable `agent_id`, generation, network mode,
internal MCP listen address, Egress endpoint, tunnel address, resolver, and
mount locations. No admission or Egress credential is used inside the trusted
platform network.

Runtime completes TUN, network mode, privilege, roots, and MCP initialization
before it listens. Controller already knows the endpoint returned by Provider:

1. poll `GET /status` until it returns the expected `(agent_id, generation)`;
2. call MCP `tools/list` and verify `bash`, `read`, `write`, and `edit`;
3. atomically route later MCP calls to that candidate generation.

The official Rust `rmcp` SDK owns MCP Streamable HTTP, discovery, schemas,
cancellation, and errors. Runtime has no reverse control session, readiness
RPC, heartbeat, lease, capability list, Work epoch, replay cache, or audit
model.

Runtime is crash-only. PID 1 exit invalidates the instance; Provider must
replace the whole container or Pod sandbox rather than restart the process in
the existing network namespace. Controller routes work only after the
replacement passes `/status` and `tools/list`.

## Filesystem

1. `/workspace` is the Agent-owned persistent Docker volume and `$HOME`.
2. Provider/container policy supplies `/skills` as a shared, read-only system
   Skill volume; Runtime does not own or enforce the mount mode.
3. `$HOME/.antnest/skills` is writable and persists with the workspace.
4. Runtime uses a read-only root filesystem and a bounded executable `/tmp`.
5. File APIs accept named-root relative paths; Runtime `write` and `edit` reject
   the system-Skill root, while Bash follows the mount permissions enforced by
   the container platform.

## Network Modes

Network mode is injected before the process starts. `restricted` returns local
TCP reset or ICMP rejection from the Rust Runtime,
so blocked calls fail quickly without opening a tunnel. `unrestricted` opens a
connected UDP socket carrying one validated raw IPv4/TCP packet per datagram
directly to Runtime Egress,
where Linux routing, conntrack, nftables, and NAT provide egress. Runtime pins
an Egress host route before replacing its default route with TUN. The internal
MCP endpoint is inbound and uses the platform network's connected route; there
is no outbound Controller session.
Kernel-generated IPv6 and unsupported L4 packets are rejected or discarded at
the Runtime boundary; they do not tear down the UDP tunnel.

DNS uses the same data path rather than a second proxy protocol. Runtime gets
the virtual resolver address and Docker `DnsOptions: use-vc`; it accepts either
that resolver directly or Docker's `127.0.0.11` embedded resolver when the
expected upstream is recorded in `resolv.conf`. Runtime Egress listens for
DNS-over-TCP on the virtual gateway address and forwards the byte stream to
`ANTNEST_RUNTIME_DNS_UPSTREAM`. Only that virtual address on TCP port 53 is an
allowed non-public destination.

Changing network mode creates a candidate generation. Controller keeps the old
generation active until the candidate status and MCP tool list pass, then
switches between Agent operations and removes the old container.

## Local Commands

```bash
cp .env.example .env
make fmt-check
make lint
make test-go
make test-rust
make docker-build
docker compose up -d postgres runtime-egress runtime-provider-docker runtime-controller
make e2e-stage1
```

The Compose file publishes loopback development ports only. PostgreSQL remains
on the internal control network; database integration tests run from a test
container on that network. `make e2e-stage1` is destructive to the uniquely
named Runtime resources it creates, requires the Compose stack and Docker CLI,
and cleans those resources when it exits.

HTTP errors use Problem Details with a stable `code`; an active OpenTelemetry
trace contributes `trace_id`. Callers must branch on `code`, not human-readable
text.

## Historical Acceptance Snapshot

- [x] Fresh Compose reaches healthy PostgreSQL, Runtime Egress, Docker Runtime
      Provider, and Runtime Controller.
- [x] Prepare creates exactly one `antnest-runtime-<agent_id>` container and one
      `antnest-workspace-<agent_id>` volume, then reaches Ready.
- [x] Repeating Prepare with the same key returns the original operation and
      creates no extra Docker resource.
- [x] `work:begin -> write/edit -> read/list -> exec -> work:end` succeeds through
      Controller HTTP and Runtime JSON-RPC.
- [x] Restricted network access fails quickly.
- [x] Switching to unrestricted creates one replacement generation, completes
      its operation, and permits a real DNS + HTTP request.
- [x] Switching back to restricted creates a replacement generation and blocks
      a real request quickly.
- [x] Runtime instance replacement and Egress, Docker Provider, and Controller
      restarts recover without duplicate container, volume, generation, or
      active session.
- [x] Stop retains the workspace; Retire removes compute only; Purge removes
      both compute and workspace.
- [x] Old generation sessions and egress reservations are released.
- [x] Controller has no Docker socket, `NET_ADMIN`, or TUN device; Egress has
      only network privilege and Provider has only Docker socket access.
- [x] Idle steady state does not poll or consume a CPU core.

The checklist was exercised on 2026-08-28 by `make test` and
`make e2e-stage1` against a fresh Compose volume. E2E verifies actual container
privileges, compares generations and Docker resource counts across four
independent restarts, and performs real blocked and allowed network requests.
Work fencing proves the old active session cannot survive a Runtime restart;
unit tests also reject an older signed token replacing newer Egress intent.
These checks remain executable acceptance evidence rather than a transcript.
