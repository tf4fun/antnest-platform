# Agent ACP Service Operations

This document covers startup and readiness, configuration rules, the ACP
endpoints, telemetry, failure handling and the network deployment boundary.

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
not recursively probed for readiness. Startup interruption cleanup uses only
this service's storage, never Controller RPCs or model/Tool execution.
Serving the protocol is not permission to execute: the current-process organization
snapshot and volatile credentials must also have been applied. Production composition
wires that directory to access, execution and revocation; see
[local execution configuration](execution-configuration.md).

The migration journal must be an exact prefix of the ordered migration catalog
embedded in the running release. A changed checksum, gap, or unknown future
version fails startup. Database migrations are forward-only; rolling the
service binary back requires restoring a database backup whose migration
journal matches that older release.

Migration `0004_session_configuration.sql` adds Session overrides/revision and
the configuration captured in each Run intent. Historical intents may retain
NULL, but startup does not replay any intent. The current configuration is
supplied by Controller's inbound snapshot publication, not by per-Run outbound
RPC. An unavailable
selected model rejects admission; it does not silently fall back to a default.

Migration `0005_tool_permissions.sql` adds this service's permission ledger,
keyed by Run and tool-call ID. Exact request payloads use JSON text inside JSONB
to preserve escaped bytes. Normal approval/execution tracing does not export
these payloads. Administrative audit RPC responses follow the global RPC content
capture setting and can therefore expose retained input and tool data to OTLP;
see [execution audit](execution-audit.md) before enabling capture.
After acquiring the exclusive worker lock, startup cancels pending approvals
before classifying interrupted Runs. Run completion also cancels orphan waits.
This does not replay approved tools or resume an interrupted Tool loop.

Approve modes need a client handler for standard `session/request_permission`.
Clients can reconnect and load/resume the same Session to answer a still-live
request. The local accepted Run deadline bounds the wait. Cancellation sends
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

The complete variable table, including the optional Skill learning and Skill
discovery settings, is in the [service README](../README.md#configuration).

Durations accept a positive integer followed by `ms`, `s`, or `m`. Invalid,
empty required, unsupported-scheme, and out-of-range values fail startup before
the database or network is touched. The listen address accepts `:port`,
`host:port`, or `[ipv6]:port`.

The database timeout uses the driver's standard connection, statement and read
limits. A shorter lifecycle deadline cancels its read immediately: borrowed
connections are discarded rather than returned with a pending query, and late
connection acquisitions are released without executing SQL. PostgreSQL's
statement timeout also bounds backend work if it does not immediately observe
the closed connection. No write result or remote tool result is inferred from
a timeout. Evidence reads occur outside the configuration publication queue;
service shutdown aborts settlement instead of reporting success.
Borrowed read and transaction connections retain their own error listener until
release. An unexpected socket failure rejects the operation and discards the
connection rather than becoming an unhandled process error. A lost transaction
connection does not prove rollback; the original/rollback errors remain visible.

The encryption key is a service bootstrap secret, not a Provider credential.
Rotation requires decrypt-with-old/encrypt-with-new maintenance and is not
performed implicitly at startup.

The repository's `.env.example` leaves the key empty. Generate a random key
with `scripts/generate-dev-env.sh` and retain it for the lifetime of the
service-owned database. Uniform 32-byte keys, including the all-zero key, fail
startup unless exact `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` explicitly permits
a disposable fixture. Standard Compose never passes that exception.

Normal execution does not resolve access or credentials from Controller.
The optional learning-policy client has its own authenticated Controller origin.
Controller calls `POST /rpc/agent-acp/apply-execution-snapshot`; its
[contract](../../../contracts/agent-acp/execution-api.md) defines complete
organization snapshots, applied revision and failure semantics. A stored snapshot
alone cannot initialize a restarted process's credentials.

## Runtime Instance Authority

Controller privately relays RC-issued ACP authority with the current Runtime
revision, execution ID, endpoint and connection ID. ACP stores only those public
fields. Its process-owned 0700 directory contains one 0600 sender file per
connection; every request verifies and rereads it. Runtime authority is never a
global `ANTNEST_SERVICE_AUTH_TOKEN_DIR/antnest-runtime` credential.

The current native Runtime profile requires `ANTNEST_SERVICE_AUTH_MODE=token`
and exact `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true`. Unsupported
TLS/mTLS Runtime composition fails startup or publication without downgrading.
The installed Runtime origin is fixed, unrelated authority is stripped, and
redirects and environment proxies are disabled.

Equal-revision publications must carry the same token for an existing connection
ID. Missing or unsafe files make calls unavailable; memory never supplies a
fallback bearer. Recover sender storage by restarting ACP and having Controller
republish the verified current private reference. A cold database snapshot or
closed publication cannot create authority.

Accepted Runs and maintenance operations retain original authority for cleanup
through closure. An authentication failure cannot erase an earlier unknown effect;
normal stopping and durable settlement rules still apply. Normal shutdown,
failed startup and worker ownership loss close the dispatcher and remove owned
sender files. See [execution configuration](execution-configuration.md#runtime-instance-authentication-30-owning-service-admission)
and the [private connection contract](../../../contracts/runtime/instance-connection.md).

## Provider Model Egress

Every foreground response, permission judge and background learning completion
uses the same [Provider destination policy](../../../contracts/platform/provider-destination-policy.md).
ACP revalidates the base URL and all A/AAAA answers before sending credentials,
normalizes mapped IPv4 and rejects any forbidden answer. DNS is bounded by the
Run/learning cancellation signal and a 10-second lookup deadline. The connection
dials a checked literal IP while retaining the original TLS hostname, SNI and
HTTP Host. Redirects and environment proxies are disabled.

Each completion owns one bounded dispatcher through the entire response body,
then destroys it on completion, failure or cancellation. It cannot use a private
service transport, service credential, CCT, cookie or baggage. Existing response
limits and execution deadlines still apply; successful output and usage semantics
are unchanged. No Provider HTTP response body enters an error.

`ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS` defaults false. Only exact `true`
or `false` is accepted; empty, padded or differently capitalized values fail
startup. Explicit true permits private/local LLM and metadata ranges and emits
`provider_private_endpoints_enabled`. It is unsafe for multi-tenant deployment;
only the operator can set it, and Controller must use the same policy. Neither a
browser request, Template, published snapshot nor Run can opt in.

Policy rejection records non-retryable `provider_endpoint_forbidden`; DNS failure
records retryable `provider_endpoint_unavailable`. These bounded classifications
are preserved in Run receipts and model/learning telemetry without the key,
raw resolver details or upstream body. They do not create a Tool side effect or
prevent a later explicit Run after the configuration/network is corrected.

## ACP Endpoint

Both `/v1/acp` and `/v2/acp` accept WebSocket upgrades. `/v1/acp` additionally
accepts SDK Streamable HTTP POST/GET SSE/DELETE; `/v2/acp` does not accept that
HTTP transport. See the [HTTP transport contract](http-transport.md).
The caller must be a verified Gateway/UI workload and supply Identity's unchanged
signed CCT with ACP audience and Agent scope. ACP derives the tuple from verified
claims; raw identity hints and the old opaque subject are not fallbacks. Both transports bind the same tuple;
resource operations check the current local grant, not a Controller RPC or a
cached connection grant. Missing current configuration returns an ACP error.

The endpoint fixes the protocol version for the complete connection. Stable v1
and draft v2 are separate adapters over the same application core. The
unversioned `/acp` has no caller grant and never negotiates a default version.

`ANTNEST_ACP_CONTROL_LISTEN` serves only Controller publication/settlement and
minimal health. Bind it to the control network; workspace returns 404 for those
operations. Both listeners must open before readiness and close on startup
failure. Exact service mode, per-receiver files and authenticated Identity origin
are mandatory; incomplete TLS or invalid replacements fail closed. The removed
`ANTNEST_ACP_SKILL_REGISTRY_TOKEN` / `ANTNEST_ACP_SKILL_SOURCE_TOKEN` settings
fail startup when nonempty. See the
[authentication contract](../../../contracts/agent-acp/service-authentication.md).

## Telemetry

W3C `traceparent`/`tracestate` is accepted at WebSocket upgrade and from ACP
request `_meta` where present. Trace context propagates to model and Runtime MCP requests.

HTTP requests and upgrades have a SERVER boundary, including successful health
requests with upstream context. A shared fetch boundary creates CLIENT before
injecting its context and tracks response consumption/close. Baggage, query
strings, authorization and cookies are not exported. See the service
[observability implementation and remaining SDK limits](observability.md).

Spans include low-risk identifiers such as Agent ID, Session ID, Run ID,
organization ID, configuration revision, execution revision, MCP source class,
and terminal class. High-cardinality identifiers are span attributes, never
metric labels.

Required low-cardinality metrics:

- ACP connections and connection result;
- Session method duration and result;
- Run admission result and rejection class;
- Run duration and terminal class;
- model request duration and result;
- MCP request duration by source class and bounded Tool policy;
- recovery-classified Runs and unresolved Runs.

Repository queries and transactions emit spans and request/duration metrics
using only the bounded SQL operation class (`select`, `insert`, `update`,
`delete`, or `transaction`). SQL text, bind values, prompts, payloads, and
credentials are never telemetry attributes.

The implemented metric namespace is `antnest.acp.*`. Request counters and
duration histograms use only bounded labels such as method, result, terminal
class, MCP source class, and model protocol. Agent, Session, Run, organization, and
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

- Configuration validation/storage failure retains the old live projection.
  Failure during publication after persistence closes the affected organization,
  aborts its execution and detaches approval/output consumers; retry the same or
  newer snapshot. Neither the request nor raw error text is telemetry content.
- Local acceptance, Run-event or terminal persistence uncertainty fails readiness
  and requests process replacement. Startup records interruption without model or
  Tool replay. No Controller admission or completion receipt is involved.
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
  No deployment allowlist option can enable client injection.
- A confirmed Runtime-managed MCP error is returned to the model as a Tool
  result; an unknown transport effect still terminates the Run as unresolved.
- PostgreSQL unavailable: readiness fails and no prompt is accepted.
- Run worker lock unavailable: startup fails because another replica owns Run
  execution. A same-session heartbeat detects loss of the dedicated lock
  connection; loss makes readiness false, aborts startup recovery and local
  execution, emits its structured stdout event, gives OTLP trace/metrics at
  most 500ms to flush, and then exits non-zero for platform replacement. This is
  a hard fail-stop, not graceful shutdown: the stale worker must not persist
  terminal Run state after ownership is lost.
  A dedicated ownership-loss channel races startup, recovery, serving, and
  graceful cleanup, so an earlier ordinary component or database failure
  cannot mask lock loss. External and durable operations, including context
  checkpoint writes, recheck ownership after both success and failure before
  any next transition. The same fail-stop path therefore cannot be delayed by
  a pending operation or ordinary component cleanup before the process exits.
- Session cancellation, close, or delete: persist a cancellation latch before
  waiting for in-memory execution. A late acceptance commit reaches an already
  aborted executor and is closed without starting model or Tool work.
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

- workspace inbound only from authenticated Gateway, Agent UI, Console and
  Registry on their documented routes; Controller uses its separate listener;
- outbound to authenticated Identity for bounded JWKS verification;
- outbound to its private PostgreSQL, configured model APIs,
  the Runtime MCP endpoint in a Run snapshot and that Runtime's private
  Skill maintenance and temporary-Skill endpoints;
- outbound to Agent Controller's internal Skill learning policy endpoint and the
  Skill Registry internal API, only when those optional features are configured;
- inbound from Skill Registry to `/internal/skill-sources/*` when Skill
  discovery is configured.
