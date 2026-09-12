# Agent ACP Service Operations

## Startup And Readiness

The process starts accepting ACP connections only after:

1. configuration validates;
2. private PostgreSQL migrations succeed;
3. the private PostgreSQL database answers the local storage check;
4. the process exclusively owns the database-scoped Run worker lock;
5. startup recovery has classified all non-terminal Runs.

`GET /status` returns `ready` only after those gates and while the worker lock
is held and shutdown has not started. Each probe checks only private PostgreSQL.
Agent Controller, model APIs and Runtime MCP are business dependencies and are
not recursively probed for readiness. Startup recovery may need actual Controller
RPCs to settle durable work; this is not a Controller health probe.

The migration journal must be an exact prefix of the ordered migration catalog
embedded in the running release. A changed checksum, gap, or unknown future
version fails startup. Database migrations are forward-only; rolling the
service binary back requires restoring a database backup whose migration
journal matches that older release.

Migration `0004_session_configuration.sql` adds Session overrides/revision and
the configuration captured in each Run intent. Historical intents retain NULL
so admission recovery sends their original request shape. F05 introduced the
Controller configuration methods and frozen admission configuration; current
deployments must use the complete Run contract linked below, which also
includes subsequent capability and pricing fields. Roll out compatible owner
and consumer binaries before admitting user traffic.
No new deployment variables or Runtime rebuilds are required. An unavailable
selected model rejects admission; it does not silently fall back to a default.

Migration `0005_tool_permissions.sql` adds this service's permission ledger,
keyed by Run and tool-call ID. Exact request payloads use JSON text inside JSONB
to preserve escaped bytes; they are audit data and never exported to OTLP.
After acquiring the exclusive worker lock, startup cancels pending approvals
before classifying interrupted Runs. Run completion also cancels orphan waits.
This does not replay approved tools or resume an interrupted Tool loop.

Approve modes need a client handler for standard `session/request_permission`.
Clients can reconnect and load/resume the same Session to answer a still-live
request. The original admission deadline bounds the wait. Cancellation sends
the SDK cancellation notification; a client ignoring it for one second loses
that logical connection, while the Run's cancellation completes independently.
No extra approval HTTP endpoint, broker, provider credential or environment
variable is introduced. Smart Approve's optional classification uses the admitted
model and credential, at most 256 output tokens and a 10-second timeout. It
shares the Run's model-request budget and reserves one normal response. Invalid,
failed or uncertain judgments ask the user; this is not a security guarantee.
Reported usage is persisted before accepting the judgment. Accounting failure
enters Run recovery rather than becoming an authorization denial. Calls failing
before a Provider reports usage cannot be given invented token counts.

## Configuration

| Variable                                | Required | Meaning                                                                               |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ANTNEST_ACP_LISTEN`                    | no       | HTTP/WebSocket listen address, default `:8080`                                        |
| `ANTNEST_ACP_DATABASE_URL`              | yes      | Private `postgres://` or `postgresql://` database URL                                 |
| `ANTNEST_AGENT_CONTROLLER_URL`          | yes      | Trusted internal `http://` or `https://` Run RPC base URL                             |
| `ANTNEST_ACP_CLIENT_MCP_KEY`            | yes      | Base64-encoded 32-byte key for retained Session MCP revisions                         |
| `ANTNEST_ACP_CONTROLLER_TIMEOUT`        | no       | Agent Controller request deadline, default `5s`                                       |
| `ANTNEST_ACP_MAX_PROMPT_BYTES`          | no       | ACP WebSocket message bound, default `16777216` bytes                                 |
| `ANTNEST_ACP_SHUTDOWN_TIMEOUT`          | no       | Graceful shutdown deadline, default `15s`                                             |
| `OTEL_SDK_DISABLED`                     | no       | `true` disables OTLP even when an endpoint is present                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | no       | OTLP base endpoint; empty disables export                                             |
| `OTEL_SERVICE_NAME`                     | no       | Defaults to `agent-acp-service`                                                       |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` | no       | `false` by default; `true` captures full discrete RPC JSON, which may include secrets |

Durations accept a positive integer followed by `ms`, `s`, or `m`. Invalid,
empty required, unsupported-scheme, and out-of-range values fail startup before
the database or network is touched. The listen address accepts `:port`,
`host:port`, or `[ipv6]:port`.

The encryption key is a service bootstrap secret, not a Provider credential.
Rotation requires decrypt-with-old/encrypt-with-new maintenance and is not
performed implicitly at startup.

The all-zero key in the repository's `.env.example` is for disposable local
data only. Production deployment must inject a random key and retain it for the
lifetime of the service-owned database.

`ANTNEST_AGENT_CONTROLLER_URL` names the service root. Business calls use
`/rpc/agent-controller/*` beneath that root. Readiness never calls its `/status`.
The complete current dependency contract is
[`../../../contracts/agent-controller/run-api.md`](../../../contracts/agent-controller/run-api.md),
with machine-readable shapes in
[`../../../contracts/agent-controller/run-contract.json`](../../../contracts/agent-controller/run-contract.json).
Stage 2 deploys this internal contract revision as one coordinated service
upgrade; rolling mixed-revision operation is not supported.

## ACP Endpoint

Both `/v1/acp` and `/v2/acp` accept WebSocket upgrades. `/v1/acp` additionally
accepts SDK Streamable HTTP POST/GET SSE/DELETE; `/v2/acp` does not accept that
HTTP transport. See the [HTTP transport contract](http-transport.md).
The caller supplies an opaque,
Agent-scoped access subject in `X-Antnest-Agent-Access-Subject`. This header is
trusted only because the service is not externally routable; Edge Gateway must
remove any external value and inject the value issued for the selected Agent.

The service validates the subject through Agent Controller before accepting
the upgrade and revalidates it before Session-management operations. Prompt
admission uses authoritative `acquire_run` rather than a duplicate access RPC.
Each HTTP transport request also revalidates its binding. Agent
Controller must advance `access_revision` when authorization, Agent mapping, or
prompt capabilities change. A stale connection receives a stable ACP error and
must reconnect. The service never logs the raw header.

The endpoint fixes the protocol version for the complete connection. Stable v1
and draft v2 are separate adapters over the same application core. The
unversioned `/acp` returns not found and never negotiates a default version.

## Telemetry

W3C `traceparent`/`tracestate` is accepted at WebSocket upgrade and from ACP
request `_meta` where present. Trace context propagates to Agent Controller,
model and Runtime MCP requests.

HTTP requests and upgrades have a SERVER boundary, including successful health
requests with upstream context. A shared fetch boundary creates CLIENT before
injecting its context and tracks response consumption/close. Baggage, query
strings, authorization and cookies are not exported. See the service
[observability implementation and remaining SDK limits](observability.md).

Spans include low-risk identifiers such as Agent ID, Session ID, Run ID,
admission ID, configuration revision, execution revision, MCP source class,
and terminal class. High-cardinality identifiers are span attributes, never
metric labels.

Required low-cardinality metrics:

- ACP connections and connection result;
- Session method duration and result;
- Run admission result and rejection class;
- Run duration and terminal class;
- model request duration and result;
- MCP request duration by source class and bounded Tool policy;
- recovery-classified Runs and unresolved admissions.

Repository queries and transactions emit spans and request/duration metrics
using only the bounded SQL operation class (`select`, `insert`, `update`,
`delete`, or `transaction`). SQL text, bind values, prompts, payloads, and
credentials are never telemetry attributes.

The implemented metric namespace is `antnest.acp.*`. Request counters and
duration histograms use only bounded labels such as method, result, terminal
class, MCP source class, and model protocol. Agent, Session, Run, admission, and
revision identifiers are trace attributes only.

Prompts, model output, Tool arguments/results, full paths, secret MCP headers,
Provider secrets, and client MCP credentials are excluded from default logs,
metrics, and traces.

Enabling RPC content capture records complete decoded parameters/results on the
receiving protocol span, including new/nested fields. HTTP and streaming content
remain excluded. No client payload cap, whitelist or per-span custom budget is
maintained; standard SDK limits apply. Deployment owners control enablement and
Collector retention. This service adds no retention service.

## Failure Handling

- Agent Controller timeout: retry only idempotent RPC with the same request ID;
  do not acknowledge a prompt with unknown admission state. Keep its durable
  `admitting` intent, fail readiness, and request process replacement so startup
  recovery repeats `acquire_run` with that exact request ID. Only an explicit
  Controller business rejection terminates it.
- Local acceptance failure after a successful admission, durable Run-event or
  terminal-state persistence failure, or an uncertain `finish_run`: fail
  readiness and request process replacement. A Run-event write failure is not
  converted into a normal terminal Run because that could strand a partial Tool
  exchange. The service does not remain healthy with a stranded admission;
  startup recovery resumes the same durable work. No speculative ACP idle state
  is emitted before that recovery establishes the terminal facts.
- Model timeout: cancel the request and terminate the Run as failed unless the
  client cancellation path applies.
- Runtime MCP timeout after dispatch: report Tool effect unknown and
  never replay the Tool automatically.
- Agent ACP Service restart during a Run: never replay model or Tool work.
  Recovery marks dispatched-but-unconfirmed Tool calls unknown, marks retained
  but undispatched calls not executed, and reports the Run unresolved only when
  an unknown Tool effect actually exists; otherwise it reports a failed,
  quiescent Run.
- Nonempty ACP client MCP input fails with `client_mcp_not_allowed`, without
  persistence, replay or a client connection. Use platform-managed Runtime MCP.
  The old `ANTNEST_ACP_CLIENT_MCP_BLOCKED_CIDRS` option has been removed; no
  deployment allowlist can enable client injection.
- A confirmed Runtime-managed MCP error is returned to the model as a Tool
  result; an unknown transport effect still terminates the Run as unresolved.
- PostgreSQL unavailable: readiness fails and no prompt is accepted.
- Run worker lock unavailable: startup fails because another replica owns Run
  execution. A same-session heartbeat detects loss of the dedicated lock
  connection; loss makes readiness false, aborts startup recovery and local
  execution, emits its structured stdout event, gives OTLP trace/metrics at
  most 500ms to flush, and then exits non-zero for platform replacement. This is
  a hard fail-stop, not graceful shutdown: the stale worker must not persist
  terminal Run state or close an admission after ownership is lost.
  A dedicated ownership-loss channel races startup, recovery, serving, and
  graceful cleanup, so an earlier ordinary component or database failure
  cannot mask lock loss. External and durable operations, including context
  checkpoint writes, recheck ownership after both success and failure before
  any next transition. The same fail-stop path therefore cannot be delayed by
  a pending operation or ordinary component cleanup before the process exits.
- Session cancellation, close, or delete: persist a cancellation latch before
  waiting for in-memory execution. A late admission response is recorded and
  closed without starting model or Tool work.
- SIGTERM: stop accepting connections, cancel active work, wait up to the
  shutdown timeout, terminate open ACP transports, persist terminal or
  unresolved facts where the executor can prove them, release the worker lock
  and database pool, then exit non-zero if cleanup or quiescence was not
  proven. Exceeding the deadline invokes a hard process exit so a stuck client
  cannot keep the container indefinitely terminating.
- ACP reconnect: active Run ownership remains in the process-level supervisor;
  an authorized `session/cancel`, close, or delete from a replacement
  connection still reaches the original Run.

All database transactions that lock both records use the canonical
Session-before-Run order. Cancellation, Session lifecycle changes, Run
admission, and durable event persistence must not introduce the inverse order.

## Deployment Boundary

The service is internal. Do not publish its port directly to the internet.
Compose or Kubernetes network policy permits:

- inbound only from Edge Gateway, Agent UI bridge, Channel Gateway, and trusted
  development clients;
- outbound to its private PostgreSQL, Agent Controller, configured model APIs,
  and the Runtime MCP endpoint in a Run snapshot.
