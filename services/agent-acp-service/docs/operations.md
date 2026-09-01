# Agent ACP Service Operations

## Startup And Readiness

The process starts accepting ACP connections only after:

1. configuration validates;
2. private PostgreSQL migrations succeed;
3. the Agent Controller status endpoint is reachable;
4. the process exclusively owns the database-scoped Run worker lock;
5. startup recovery has classified all non-terminal Runs.

`GET /status` returns `ready` only after those gates. Model APIs and Runtime MCP
are per-Run dependencies and do not block process readiness.

The migration journal must be an exact prefix of the ordered migration catalog
embedded in the running release. A changed checksum, gap, or unknown future
version fails startup. Database migrations are forward-only; rolling the
service binary back requires restoring a database backup whose migration
journal matches that older release.

## Configuration

| Variable                               | Required | Meaning                                                     |
| -------------------------------------- | -------- | ----------------------------------------------------------- |
| `ANTNEST_ACP_LISTEN`                   | no       | HTTP/WebSocket listen address, default `:8080`              |
| `ANTNEST_ACP_DATABASE_URL`             | yes      | Private `postgres://` or `postgresql://` database URL       |
| `ANTNEST_AGENT_CONTROLLER_URL`         | yes      | Trusted internal `http://` or `https://` Run RPC base URL   |
| `ANTNEST_ACP_CLIENT_MCP_KEY`           | yes      | Base64-encoded 32-byte key for client MCP header encryption |
| `ANTNEST_ACP_CLIENT_MCP_BLOCKED_CIDRS` | no       | Additional comma-separated networks blocked for client MCP  |
| `ANTNEST_ACP_CONTROLLER_TIMEOUT`       | no       | Agent Controller request deadline, default `5s`             |
| `ANTNEST_ACP_MAX_PROMPT_BYTES`         | no       | ACP WebSocket message bound, default `16777216` bytes       |
| `ANTNEST_ACP_SHUTDOWN_TIMEOUT`         | no       | Graceful shutdown deadline, default `15s`                   |
| `OTEL_SDK_DISABLED`                    | no       | `true` disables OTLP even when an endpoint is present       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`          | no       | OTLP base endpoint; empty disables export                   |
| `OTEL_SERVICE_NAME`                    | no       | Defaults to `agent-acp-service`                             |

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

`ANTNEST_AGENT_CONTROLLER_URL` names the service root. Readiness calls
`GET /status`; business calls use `/rpc/agent-controller/*` beneath that root.
The complete revision-8 dependency contract is
[`../../../contracts/agent-controller/run-api.md`](../../../contracts/agent-controller/run-api.md),
with machine-readable shapes in
[`../../../contracts/agent-controller/run-contract.json`](../../../contracts/agent-controller/run-contract.json).
Stage 2 deploys this internal contract revision as one coordinated service
upgrade; rolling mixed-revision operation is not supported.

## ACP Endpoint

`GET /v1/acp` and `GET /v2/acp` must be WebSocket upgrades. The caller supplies an opaque,
Agent-scoped access subject in `X-Antnest-Agent-Access-Subject`. This header is
trusted only because the service is not externally routable; Edge Gateway must
remove any external value and inject the value issued for the selected Agent.

The service validates the subject through Agent Controller before accepting
the upgrade and revalidates it before every ACP business operation. Agent
Controller must advance `access_revision` when authorization, Agent mapping, or
prompt capabilities change. A stale connection receives a stable ACP error and
must reconnect. The service never logs the raw header.

The endpoint fixes the protocol version for the complete connection. Stable v1
and draft v2 are separate adapters over the same application core. The
unversioned `/acp` returns not found and never negotiates a default version.

## Telemetry

W3C `traceparent`/`tracestate` is accepted at WebSocket upgrade and from ACP
request `_meta` where present. Trace context propagates to Agent Controller,
model, client MCP, and Runtime MCP requests.

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

Prompts, model output, Tool arguments/results, full paths, MCP headers,
Provider secrets, and client MCP credentials are excluded from default logs,
metrics, and traces.

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
- Runtime or client MCP timeout after dispatch: report Tool effect unknown and
  never replay the Tool automatically.
- Agent ACP Service restart during a Run: never replay model or Tool work.
  Recovery marks dispatched-but-unconfirmed Tool calls unknown, marks retained
  but undispatched calls not executed, and reports the Run unresolved only when
  an unknown Tool effect actually exists; otherwise it reports a failed,
  quiescent Run.
- A confirmed client MCP failure is returned to the model as a Tool error;
  Runtime MCP and other client sources remain available.
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
  the Runtime MCP endpoint in a Run snapshot, and validated client MCP hosts.
