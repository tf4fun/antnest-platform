# Antnest Runtime

Antnest Runtime is the per-Agent execution process. It runs inside one isolated
Linux container, establishes the container's network boundary, and exposes four
built-in tools, configured managed stdio MCP tools, and a Runtime information
Resource through the official MCP `2026-07-28` Streamable HTTP transport. It
exists so that Agent-selected commands and file operations run behind a fixed
privilege and network boundary. It is written in Rust.

The long-lived root Supervisor (`antnest-runtime serve`, container PID 1) never
executes Agent-selected work itself. Every tool call runs in a one-shot Executor
subprocess that drops irreversibly to UID/GID 1000 with no capabilities, and all
UID 1000 network traffic is forced through a TUN device to Runtime Egress.

## Responsibilities

- Run as root container PID 1 and own MCP, TUN, the Egress packet tunnel,
  telemetry, signals, and orphan process reaping.
- Execute `bash`, `read`, `write`, and `edit` through explicit one-shot
  UID/GID 1000 subcommands with bounded time and output. `read` defaults to the
  first 2000 lines; `bash` defaults to the workspace and a 120-second timeout.
- Start configured `mcp_servers` from RuntimeSpec as UID/GID 1000 stdio
  processes and aggregate their tools into the same `/mcp` endpoint.
- Serve `antnest://runtime/info`: bounded environment facts, root `AGENTS.md`,
  and Skill metadata collected by the non-root `info` subprocess.
- Deliver bounded live Bash output and managed MCP progress through standard
  request-scoped notifications ([Tool progress](docs/tool-progress.md)).
- Return bounded file locations and observed text differences in MCP result
  metadata ([File observations](docs/file-observations.md)).
- Send UID/GID 1000 traffic through TUN while keeping root control traffic on
  the platform main routing table, and carry structurally valid IPv4/TCP
  packets to Runtime Egress as one raw packet per UDP datagram.
- Preserve background processes across successful calls and turns.
  Cancellation targets only the current invocation's process group.
- Accept signed, Run-bound temporary Skill packages and signed Skill
  maintenance requests through private HTTP endpoints, and apply them as
  UID/GID 1000 inside the workspace.
- Authenticate full status and the entire MCP/private Skill mount with RC-issued,
  instance-specific workload credentials before SDK dispatch. Expose identity-free
  `GET/HEAD /status/live` for Docker liveness.
- Emit structured stderr logs and optionally export traces and metrics over
  OTLP, preserving local trace correlation when export is disabled.

## Non-responsibilities

- Creating, replacing, retiring, or purging its container, Pod, or volume.
- Accessing Docker, PostgreSQL, or Controller persistence.
- Agent loops, model calls, prompts, memory, or Skill Registry behavior.
- Choosing or applying Agent network policy, or authorizing end users. Allow
  and deny decisions belong only to Runtime Egress.
- Agent scheduling, Work/session identity, replay policy, or side-effect
  reconciliation.
- Service registration, discovery, or a reverse control connection.
- Managed MCP elicitation. It is deferred until the official SDK supports it
  ([Elicitation](docs/elicitation.md)).

## Interfaces

| Direction | Interface                                            | Purpose                                                                  |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Inbound   | `GET /status`                                        | Authenticated Runtime identity/readiness for RC and ACP                  |
| Inbound   | `GET/HEAD /status/live`                              | Only `status`, without identity or execution authority                   |
| Inbound   | `/mcp`, all methods/subpaths                         | ACP workload admission before SDK dispatch; requires the execution fence |
| Inbound   | `POST /internal/skill-maintenance/{action}`          | Signed Skill maintenance requests from Agent ACP Service                 |
| Inbound   | `POST /internal/skill-temporary/install`, `/release` | Signed temporary Skill delivery from Agent ACP Service                   |
| Outbound  | Connected UDP socket to Runtime Egress               | Raw IPv4/TCP packet tunnel for all UID 1000 traffic                      |
| Outbound  | OTLP HTTP/protobuf                                   | Optional trace and metric export to a private Collector                  |

All inbound endpoints listen on an internal platform address and must not be
published outside the trusted Docker or Kubernetes network.

## Configuration

Skill maintenance verifier key IDs use the shared
[RuntimeSpec grammar](../../contracts/runtime/runtime-spec.schema.json#/$defs/maintenanceKid)
and [accept/reject fixtures](../../contracts/runtime/maintenance-kid-fixtures.json).
Startup rejects invalid IDs and reports duplicate IDs separately.

| Variable                                        | Required | Default                                        | Description                                                                                                                                                                                                |
| ----------------------------------------------- | -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTNEST_RUNTIME_SPEC`                          | Yes      | none                                           | Immutable RuntimeSpec as a JSON document. Decoded strictly (unknown fields rejected) against [runtime-spec.schema.json](../../contracts/runtime/runtime-spec.schema.json). Supplied by Runtime Controller. |
| `ANTNEST_SERVICE_AUTH_MODE`                     | Yes      | none                                           | Exactly `token`. Native Runtime has no TLS listener; `mtls` fails startup.                                                                                                                                 |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` | Yes      | none                                           | Exactly `true`, explicitly permitting the private HTTP-only instance profile.                                                                                                                              |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`             | Yes      | none                                           | Exactly `/run/antnest-auth/callers.json`, in RC's verified read-only receiver volume.                                                                                                                      |
| `ANTNEST_RUNTIME_IMAGE_REFERENCE`               | No       | empty                                          | Configured image name/tag/digest, attached to telemetry resources.                                                                                                                                         |
| `ANTNEST_RUNTIME_IMAGE_ID`                      | No       | empty                                          | Resolved image ID, attached to telemetry resources.                                                                                                                                                        |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`         | No       | `false`                                        | `true` captures complete MCP request/result JSON on RPC spans. May contain secrets.                                                                                                                        |
| `RUST_LOG`                                      | No       | `info,hyper=warn,reqwest=warn`                 | Stderr log filter. Only `antnest_runtime` targets are emitted.                                                                                                                                             |
| `OTEL_SDK_DISABLED`                             | No       | unset                                          | `true` disables trace and metric export.                                                                                                                                                                   |
| `OTEL_TRACES_EXPORTER`                          | No       | unset                                          | `otlp` or `none`. When unset, export is enabled only if an OTLP endpoint is set.                                                                                                                           |
| `OTEL_METRICS_EXPORTER`                         | No       | unset                                          | `otlp` or `none`, with the same rule as traces.                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   | No       | `http://127.0.0.1:4318` when export is enabled | Common OTLP base URL. Must be `http` with a literal IPv4 address on the direct platform network.                                                                                                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`            | No       | derived from common endpoint                   | Trace endpoint override.                                                                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`           | No       | derived from common endpoint                   | Metric endpoint override.                                                                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                   | No       | `http/protobuf`                                | The only supported protocol is `http/protobuf`.                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`            | No       | common protocol                                | Trace protocol override.                                                                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`           | No       | common protocol                                | Metric protocol override.                                                                                                                                                                                  |

Individual variables such as an Agent ID or Egress endpoint are not alternate
inputs; RuntimeSpec is the only deployment configuration. Telemetry variables
are never copied into Executor environments.

Production `serve` additionally requires RuntimeSpec's nonsecret `authentication`
descriptor: an RC-issued connection ID, the fixed callers path, and the complete
receiver file digest. Before network setup or HTTP, Runtime validates the root
directory (UID/GID 0, mode 0700), the sole regular file (UID/GID 0, mode 0600),
its digest and the strict bounded RC/ACP hash profile. Missing files, links,
FIFOs, extra entries, duplicate JSON members and unsupported TLS configuration
fail closed. Neither bearer enters RuntimeSpec, the Runtime environment or tool
subprocesses. See the [private instance contract](../../contracts/runtime/instance-connection.md).

Requests use the dedicated `Antnest-Service-Authorization` header. Unknown or
malformed authority returns `401 runtime_unauthorized`; a known wrong caller gets
`403 caller_not_allowed`. The owned `antnest-runtime-<agent_id>` alias and loopback
hosts require the exact configured port. MCP remains stateless; execution fences
and independently signed Skill tickets remain mandatory. JSON POSTs reject
ambiguous/non-UTF-8 input; the two signed Skill upload routes retain multipart.

The Supervisor sets these internal variables for its own subprocesses. They
are not operator settings, and managed MCP server `env` entries cannot use the
reserved `ANTNEST_` prefix:

- `ANTNEST_RUNTIME_WORKSPACE` (Executor default `/workspace`) and
  `ANTNEST_RUNTIME_SYSTEM_SKILLS` (Executor default `/skills`): named roots
  passed from RuntimeSpec `filesystem` to each Executor.
- `ANTNEST_MANAGED_MCP_CONFIG`: the server configuration passed to the
  `mcp-stdio` launcher, together with `ANTNEST_RUNTIME_WORKSPACE`.
- `ANTNEST_PROBE_SYSTEM_SKILLS`: used only by the startup execution probe.

## Dependencies

- Linux with TUN, policy routing, nftables, and `openat2` (Linux 5.6 or newer).
  TUN, privilege, and network code paths are Linux-only; launching the binary
  elsewhere fails closed.
- Container capabilities and mounts described in
  [Security and operations](docs/security-and-operations.md): `/dev/net/tun`,
  a writable `/workspace` volume, a read-only `/skills` mount, and bounded `/tmp`.
- Runtime Egress: the packet path must answer a readiness probe before
  `/status` is served. Loss of the tunnel is fatal.
- Configured managed MCP servers: every server must initialize before
  readiness; losing a required server makes Runtime unavailable and exits.
- Optional OTLP Collector. Export failure never changes readiness or results.

The production image includes Python, Node.js with npm, Git, and curl for
Agent and managed MCP use. Runtime does not install Skill dependencies.

## Build and test

Commands run from the repository root. Building requires `libnftables-dev` and
`pkg-config`; the runtime image installs `libnftables1`.

```bash
make fmt-check
make lint
make test-rust
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
make e2e-stage1
```

Crate-local checks from `runtimes/antnest-runtime/`:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

The Docker build must use the repository root as context because it copies
`contracts/runtime` and the root integration sources. Its build stage runs
`cargo fmt --check`, Clippy with warnings denied, and the test suite before
producing the release binary, so it is also the Linux compile and test gate.
Host checks cover portable logic; Linux-only cases require the Docker build.

Release images must use the default, last Docker target, `release`. Its `build`
stage never reads `ANTNEST_RUNTIME_FEATURES` or enables Cargo features, even if a
caller supplies that build argument. The release image has the label
`dev.antnest.runtime.test-features=""` and `/status` reports `test_features: []`.
CI checks both default and test-feature binaries, but publishes only this
default target.

Test-feature images require an explicit target and a nonempty feature argument:

```sh
docker build --target e2e --build-arg ANTNEST_RUNTIME_FEATURES=skill-maintenance-e2e-gate -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:skill-learning-e2e .
```

The `build-e2e` stage runs feature-enabled checks and produces a separate binary.
The `e2e` image records the supplied feature names in
`dev.antnest.runtime.test-features` and sets
`ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true`. `serve` rejects a binary containing
test features before ordinary bootstrap unless this variable is exactly `true`
(no whitespace trimming or case folding). When allowed, it logs one
`test_features_enabled` warning listing the compiled features. The status field
always comes from the binary; setting the variable cannot enable features in a
release binary. These images must never be published as releases.

Upgrade Runtime Controller's status reader before deploying images with the
new required field; see the [status contract](../../contracts/runtime/status.md).
RC image admission is delivered in #29; coordinated deployment remains pending
on `feat/service-authentication`.

- Unit and component tests live in `src/`.
- The `executor_cli` and `runtime_startup` integration tests and SDK, wire, network, and process
  integration sources live in
  [`tests/integration/antnest-runtime`](../../tests/integration/antnest-runtime).
- `make e2e-stage1` starts the real PID 1 binary with TUN and container
  capabilities, checks the execution and network boundaries, exercises MCP,
  restarts Runtime to verify network-state reconciliation, and verifies
  Runtime/Egress policy changes.
- The isolated managed MCP suite in
  [`tests/e2e/antnest-runtime`](../../tests/e2e/antnest-runtime) needs no
  database, Provider, or Controller:

```sh
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-e2e .
python3 tests/e2e/antnest-runtime/e2e_managed_mcp.py
```

Only the build stage contains the managed MCP test fixture; it is not
shipped in the production image. Override `ANTNEST_RUNTIME_BUILD_IMAGE` and
`ANTNEST_RUNTIME_TEST_IMAGE` to select other local tags.

Test-only build options and variables:

- Cargo feature `skill-maintenance-e2e-gate` (explicit Docker target `e2e` and
  build argument `ANTNEST_RUNTIME_FEATURES=skill-maintenance-e2e-gate`) holds Skill commits
  while `/workspace/.antnest/skill-learning/e2e-commit-gate/hold` exists, so
  E2E tests can observe the in-progress commit window. It also holds a Skill
  install after its rename while
  `/workspace/.antnest/skill-learning/e2e-install-gate/hold` exists, so E2E
  tests can preempt it with foreground work. It must never be enabled in
  published images.
- `ANTNEST_RUNTIME_BUILD_IMAGE` and `ANTNEST_RUNTIME_TEST_IMAGE` select images
  for the isolated E2E suite. `ANTNEST_RUNTIME_GATE_IMAGE` selects the
  test-feature image for `tests/e2e/skill-learning/runtime-install.mjs`.

No production image is published yet. Local images use
`antnest/antnest-runtime:<tag>`. A shared contract change must pass Runtime,
Runtime Controller, and Runtime Egress before an image is promoted.

The isolated #30 receiver gate builds both release and test-feature binaries,
uses a readiness-only UDP fixture and the official MCP client, and covers actual
authentication, Host admission, executor isolation, signed learning/temporary
uploads, restart and invalid bootstrap:

```sh
node tests/e2e/service-authentication/runtime/run.mjs
```

It creates no host ports or real model calls, removes only its owned Docker
resources and credentials, and saves private evidence under
`artifacts/verification/`. Controller relay, ACP instance-client adoption and
cross-service business/security E2E are subsequent owning-service/integration
batches; this receiver gate does not complete the platform workflow.

## Documentation

- [Architecture](docs/architecture.md) - bootstrap, execution model, module
  ownership, transport, filesystem, and network behavior.
- [MCP contract](docs/mcp-contract.md) - status, tools, information Resource,
  managed tools, and errors.
- [Security and operations](docs/security-and-operations.md) - trust boundary,
  container shape, privileges, mounts, and failure diagnosis.
- [Observability](docs/observability.md) - logs, spans, metrics, propagation,
  and OTLP configuration.
- [Tool progress](docs/tool-progress.md) - live progress notifications.
- [File observations](docs/file-observations.md) - file location and diff metadata.
- [Elicitation](docs/elicitation.md) - deferral decision for managed MCP elicitation.
- [Runtime context and managed MCP](../../docs/runtime-context-and-managed-mcp.md) -
  cross-service design for the information Resource and managed servers.
- [contract.json](../../contracts/runtime/contract.json) - status, MCP
  transport, tool names, and error code contract.
- [runtime-spec.schema.json](../../contracts/runtime/runtime-spec.schema.json) -
  RuntimeSpec input contract.
- [runtime-status.schema.json](../../contracts/runtime/runtime-status.schema.json) -
  readiness and compiled test-feature identity.
- [builtin-tools.schema.json](../../contracts/runtime/builtin-tools.schema.json) -
  built-in tool input contract.
- [temporary-skills.md](../../contracts/runtime/temporary-skills.md) - temporary
  Skill delivery contract.
- [packet-format.md](../../contracts/runtime/packet-format.md),
  [packet-contract.json](../../contracts/runtime/packet-contract.json), and
  [packet-fixtures.json](../../contracts/runtime/packet-fixtures.json) - raw
  IP over UDP tunnel contract and examples.

Managed MCP processes use dedicated reserved identities (UIDs 2000..2007),
assigned by sorted server IDs, sharing only workspace GID 1000. Each server has
0700 HOME/TMPDIR/XDG directories in a bounded private tmpfs and uses umask 077;
cwd remains workspace. Reordering IDs preserves their UID; adding/removing IDs
may reassign it, so shared workspace files have no persistent per-server ownership
guarantee. Cache data resets on restart. Secret configuration is read from an RC-owned
root-only bootstrap mount, never the Runtime/launcher environment. See the
[managed secret contract](../../contracts/runtime/managed-mcp-secrets.md). RC owns
private-volume delivery and Console the write-only editor; root managed-MCP
acceptance verifies the complete cross-service flow.
