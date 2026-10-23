# Agent ACP Service Operations

This document covers startup and readiness, configuration rules, the ACP
endpoints, telemetry, failure handling and the network deployment boundary.

## Startup And Readiness

The process starts accepting ACP connections only after:

1. configuration validates;
2. optional incarnation bootstrap opens its independent private probe and
   validates the Runtime Controller registration receipt;
3. private PostgreSQL migrations succeed;
4. the private PostgreSQL database answers the local storage check;
5. the process exclusively owns the database-scoped Run worker lock;
6. startup inventory/recovery and sealed configuration restoration complete.

Registered owner mode isolates scopes containing protected owned work and runs
legacy recovery only within approved organization/Agent scopes. With owner
settings disabled, startup keeps the original global legacy recovery path.

`GET /status` returns `ready` only after those gates and while the worker lock
is held and shutdown has not started. Each readiness probe checks only private
PostgreSQL.
Agent Controller, model APIs and Runtime MCP are business dependencies and are
not recursively probed for readiness. Startup interruption cleanup uses only
this service's storage, never Controller RPCs or model/Tool execution.
Serving the protocol is not permission to execute: the current-process organization
snapshot and volatile credentials must also have been applied. Production composition
wires that directory to access, execution and revocation; see
[local execution configuration](execution-configuration.md).

### Optional ACP Incarnation Bootstrap

Leave all four owner settings unset to keep bootstrap disabled. To enable it,
configure `ANTNEST_ACP_OWNER_MEMBER_ID`, `ANTNEST_ACP_OWNER_LISTEN` and
`ANTNEST_ACP_RUNTIME_CONTROLLER_URL` together. There is no default member,
owner address or Runtime Controller origin. A partial group, including a
registration timeout configured alone, fails configuration before database or
network access.

- `ANTNEST_ACP_OWNER_MEMBER_ID` is an exact 1–64-character catalog label using
  lowercase ASCII letters, digits and hyphens, beginning and ending with a
  letter or digit. It is not trimmed or derived from a container selector.
- `ANTNEST_ACP_OWNER_LISTEN` requires a literal IPv4 `address:port` or bracketed
  IPv6 `[address]:port`, with port 1–65535 and no surrounding whitespace.
  Hostnames, unspecified addresses, multicast, broadcast and overlap with an
  ordinary workspace/control listener are rejected. Bind it to the private
  address configured in Runtime Controller's operator-owned member catalog.
- `ANTNEST_ACP_RUNTIME_CONTROLLER_URL` is a fixed `http://` or `https://` origin,
  with no credentials, non-root path, query, fragment, port zero or surrounding
  whitespace. It must differ from the configured Identity, Registry and
  learning-policy Controller origins. Runtime Controller requires its own
  receiver-specific service sender credential and trusted transport.
- `ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT` defaults to `30s`. It accepts a
  positive integer duration in `ms`, `s` or `m`, up to `120s`, shared by private
  listener startup, registration attempts and retry delays.

The process creates one fresh random incarnation and registration nonce before
opening `POST /internal/acp-owner/incarnation/probe` on the independent owner
listener. Only authenticated Runtime Controller workload calls are admitted;
the route does not use user CCT, Identity, PostgreSQL, Controller publication or
ordinary readiness. Existing workspace, control and health listeners do not
serve it. A successful challenge matches the still-pending local intent and
does not consume it. Configure Runtime Controller's matching member catalog and
the service workload credentials separately; ACP receives no Docker authority.

Startup then registers that original member/incarnation/nonce tuple with
Runtime Controller and validates the returned member/incarnation and opaque
registration identifier. Only a validated receipt allows database migration,
worker-lock acquisition, recovery, restoration and ordinary listening to begin.
The registration gate is not a recurring Runtime Controller health check.

Unknown or retryable registration outcomes make at most three attempts, with
250ms before the second and 500ms before the third. Each attempt has a
ten-second maximum within the remaining total budget. HTTP 4xx responses other
than 408 and 429 terminate registration without retry. Retries preserve the
same tuple and nonce; they do not start a new incarnation, choose a new member
or replay a Prompt, Model call or Tool call. Each original request, response
read and cancellation cleanup actually settle before the next attempt starts.
Failed cleanup ends startup. Exhausted attempts or budget leave the service
unready and fail startup after cleanup.

SIGTERM/SIGINT during startup cancels registration or its backoff and permanently
closes pending intent immediately. Shutdown retains the original registration,
body cancellation and owner listener resources; a late successful receipt
cannot reopen the intent or continue ordinary startup. The first signal or
global ownership loss establishes one absolute deadline from the configured
shutdown timeout; repeated signals do not reset it. Deadline expiry forces a
non-zero exit without claiming that original work or cleanup joined.
The owner wire uses `no-store` and suppresses request, response and error payload
capture even when RPC content capture is enabled. Logs do not include nonces,
credentials or configured private probe addresses.

The internal inspection adapter accepts only authenticated, fully bound
Runtime Controller inspection results. `unknown`, HTTP 404, transport failure,
an expired lease or a missing heartbeat is not an executor stop proof. The
adapter issues one bounded request without retry or redirect and joins its
original work before returning or rejecting. A returned stop receipt still
requires the future owned-predecessor recovery consumer to persist it under the
current Agent fence. Production scoped legacy recovery does not consume these
stop receipts.

After registration, production routes application, settlement, state, commands
and source reads through fixed Agent generations. Session, Run, Permission,
Temporary Skill and Learning writers use captured owned authority; background
workers retain their scopes. Startup inventory isolates protected owned work
and permits only approved scoped legacy recovery. `loadOwnedAuthority` rechecks
sealed configuration under the fixed fence. Disabled owner mode keeps the
original legacy path.

The complete accepting-Agent ACK runs outside publication. Its failure does not
withdraw healthy applied configuration, but the organization-wide ACK cannot
guarantee that Controller independently marks a healthy new Agent ready. The
generation manager uses a 30-second lease, 10-second renewal interval and
10-second operation budget; these values are not configurable. Legacy
compatibility writes still use held global worker-lock authority, while work
cancellation uses the entry signal. Learning retains and joins original model
work.

The global worker lock, single-instance restriction and independent
ownership-loss fail-stop channel remain. Production predecessor stop-proof
and Learning claim/global review-slot recovery, cross-owner ACKs and peers,
and two-replica integration remain pending.
Warm production admission uses real ACP startup, PostgreSQL, authenticated HTTP
registration/probes and v1/v2 WebSockets with controlled model and Runtime peers;
it does not establish a real Runtime Controller/Runtime deployment or two replicas.
See the [owner handoff contract](../../../contracts/agent-acp/owner-handoff.md).

### PostgreSQL Migration And Recovery

The migration journal must be an exact prefix of the ordered migration catalog
embedded in the running release. A changed checksum, gap, or unknown future
version fails startup. Database migrations are forward-only; rolling the
service binary back requires restoring a database backup whose migration
journal matches that older release.

Migration `0024_agent_run_admission.sql` backfills each Run's organization and
Agent from its Session and enforces one `admitting` or `running` Run per Agent
scope. All historical input, messages and terminal facts are retained. Existing
duplicate active reservations make this migration fail atomically, including
its journal entry; startup stays unready. Diagnose the original Runs and their
recovery facts before retrying the upgrade. Do not delete history, disable the
constraint or invent terminal outcomes to bypass the conflict.

The resulting `agent_busy` rejection is retryable under the existing error
contract, but does not authorize replay of a recorded or uncertain Prompt.
Cancellation requests and worker exit do not release a durable reservation;
only a committed terminal transition does. Runtime stopping and unknown-effect
barriers remain independent. The database-wide worker lock is still required:
durable admission alone does not enable additional ACP replicas or define lease
ownership and handoff.

Migration `0025_agent_leases.sql` adds the storage foundation for partitioned
ownership. It creates an initially empty lease table and does not switch the
service to multiple replicas. Registered owner mode now uses the lease
coordinator, and composition still acquires the global worker lock. There is no
peer listener or lease tuning environment variable. Do not remove the global
lock to use these primitives.

Migration `0026_run_execution_owner.sql` records the original registration,
member, incarnation and epoch on each newly owned Run intent. The four private
columns are either all null for legacy execution or a complete validated tuple.
Existing Runs stay all null, even when their Agent has a current lease. A
database trigger rejects later backfill, replacement or clearing of that tuple.

Migration `0028_owner_stop_recovery.sql` adds immutable `owner_stop_receipts` and
`run_owner_recoveries`. The full stopped response keeps its diagnostic timestamp
string; neither a different receipt for that registration nor a changed response
can replace it. The recovery association records the original Run identity and
the first recovering authority separately. A dedicated current-fence transaction
records these facts with Run recovery; ordinary writers still reject another
owner's Run. ACP stop proof cannot mark a Runtime stopped or release Temporary
resources. Production startup and predecessor Learning recovery do not consume
these tables yet; the global worker lock remains required.

The owned Run repository factory captures one immutable registration and fence.
Intent, accept, reject, cancellation, event/tool-attempt and terminal writes verify the live lease and actual
Session/Run scope in the same transaction; existing Runs must also match their
original execution tuple before mutations or duplicate receipt returns. Terminal
transactions take the organization barrier before the lease, Session and Run;
refusal exclusions, checkpoint deletion, permission cancellation and barrier
creation remain atomic. Legacy startup recovery rejects a scan containing owned
active Runs before returning any work. Legacy Run writers reject owned rows.
Registered owner composition now selects fixed owned repository factories;
owner-disabled composition retains the explicit legacy factory with held worker
authority. Scoped legacy compatibility recovery never rewrites owned execution.
Registration does not enable additional replicas.

Context checkpoint writes now receive their original Run ID through the real
RunExecutor/ContextBuilder path. The same bound factory checks lease, Session,
origin and running state before insertion or duplicate handling. Completed Runs
cannot recreate checkpoints removed by refusal. Registered owner composition
uses the fixed generation's authority; owner-disabled composition keeps held
legacy worker authority.

Lease epochs are positive decimal strings, retained after release and bounded
by PostgreSQL's signed bigint maximum. The repository accepts durations from
1 to 300 seconds; it samples database time after acquiring each lease row lock.
Its transactions and the new fenced transaction helper use a 10-second default
whole-transaction budget. PostgreSQL 17
[`transaction_timeout`](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-TRANSACTION-TIMEOUT)
enforces that budget, including a callback that keeps issuing SQL statements.
The helper joins the actual callback and rollback before releasing its client;
timeouts and lost commit receipts remain failures, never permission to retry an
effect. These callbacks must contain database work only. Existing transactions
without this option retain their existing configured statement budgets.

Production predecessor stop-proof recovery, cross-owner configuration/revocation
ACKs and trusted peers, two-replica integration, and predecessor Learning
claim/global review-slot recovery remain required. The
[ownership contract](../../../contracts/agent-acp/agent-ownership.md) records
those remaining gates. Lease rows must not be deleted to reset an epoch.

Migration `0021_tool_finish_receipts.sql` retains the original Tool finish
stopping-evidence input separately from the current `runtime_call_stopped`
value, which temporary Skill cleanup can later advance. Historical rows retain
NULL because that original input cannot be inferred safely; they are not
acknowledged as an exact finish retry. The new field is private persistence
metadata and is not added to ACP events.

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
After acquiring the exclusive worker lock, registered owner startup cancels
abandoned legacy approvals only in inventory-approved scopes; protected owned
work stays isolated. Owner-disabled startup retains global legacy cancellation
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
fallback bearer. Recover sender storage through authenticated sealed private
configuration restoration or a verified Controller republication. Registered
owner restoration rechecks the fixed fence with `loadOwnedAuthority`; a public
database projection or closed publication alone cannot create authority.

Accepted Runs, source digest reads and temporary-Skill operations retain
original authority for cleanup through closure. A Skill install keeps its
authority only until its attempt ends; a resend uses the current binding. An authentication failure cannot erase an earlier unknown effect;
normal stopping and durable settlement rules still apply. Normal shutdown and
failed startup close the dispatcher and remove owned sender files. Global
worker-loss cleanup retains the original startup and single shutdown under the
same absolute deadline; forced exit at expiry proves no completed join. Both
legacy service shutdown and owned generation retirement retain original Learning
inference through its native transport close. See [execution configuration](execution-configuration.md#runtime-instance-authentication-30-owning-service-admission)
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

The 1024-entry HTTP connection limit also counts pending SDK cleanup and
unacknowledged server-closed connections. The latter retain their original
binding and cleanup result for a fixed five minutes so that the same authorized
caller can complete DELETE; successful acknowledgement removes the ID. Unfinished
cleanup and already admitted responses hold the entry's capacity until settlement;
the original deadline and shutdown can still abort those responses. Expiry removes
the addressable ID without freeing pending cleanup. Cleanup failure remains a 503 and is logged as
`acp_http_close_failed`; it cannot be reported as a successful DELETE.
The caller must be a verified Agent UI workload and supply Identity's unchanged
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

The workspace `watch_agent_execution_state` SERVER records
`antnest.stream.termination=process-shutdown` only when its caught error is the
original normal `RunSupervisor.shutdown()` reason. It preserves the existing
ERROR status, sanitized error event, response envelope and span lifetime. An
earlier service failure, an identical error message, a wrapped cause, caller
disconnect, revocation or another storage/delivery failure does not establish
this marker. The marker identifies the propagated error; consumers must still
bind the stream to actual process lifecycle evidence before classifying an
expected shutdown. Unmarked historical errors remain unclassified. See the
[shared shutdown evidence contract](../../../docs/observability-contract.md#acp-workspace-stream-shutdown).

An ACP v1 HTTP GET can also retain one `antnest.stream.termination` event when
an original `DomainError/access_denied` from a session-output, learning-notice or
permission failure actually closes that connection. The fixed event identifies
the source and trusted Agent/organization; it contains no error text or content.
It is recorded before SDK close, which can finish the response before outer HTTP
cleanup runs. Existing ERROR status and stream lifetime remain unchanged.
Completed responses, other connections, ordinary RPC rejections and wrapped or
lookalike errors receive no such event. Consumers must also verify the actual
offboarding evidence; see the [close evidence contract](../../../docs/observability-contract.md#acp-http-access-revocation-closure).

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
  newer snapshot. The accepting-Agent ACK runs after publication; ACK failure
  does not withdraw healthy applied configuration. Neither the request nor raw
  error text is telemetry content.
- Uncertain initial Run acceptance closes the affected generation in registered
  owner mode. Legacy/global failures retain the service-recovery path. Startup
  never replays model or Tool work, and protected owned work remains isolated
  pending predecessor stop-proof recovery.
  Run-event and terminal acknowledgement failures use the scoped recovery path
  below. No Controller admission or completion receipt is involved.
- Model timeout: cancel the request and terminate the Run as failed unless the
  client cancellation path applies.
- Runtime MCP timeout after dispatch: report Tool effect unknown and
  never replay the Tool automatically.
- Agent ACP Service restart during a Run: never replay model or Tool work.
  Recovery of selected legacy Runs marks dispatched-but-unconfirmed Tool calls
  unknown, marks retained but undispatched calls not executed, and reports the
  Run unresolved only when an unknown Tool effect actually exists; otherwise it
  reports a failed, quiescent Run. Inventory protects unfinished owned work;
  scoped legacy cleanup cannot clear it.
- Nonempty ACP client MCP input fails with `client_mcp_not_allowed`, without
  persistence, replay or a client connection. Use platform-managed Runtime MCP.
  No deployment allowlist option can enable client injection.
- A confirmed Runtime-managed MCP error is returned to the model as a Tool
  result; an unknown transport effect still terminates the Run as unresolved.
- PostgreSQL unavailable: readiness fails and no prompt is accepted.
- Controller can read a scoped recovery fact through
  `POST /rpc/agent-acp/get-runtime-barrier` on the control listener. It requires
  the Controller workload credential and no user CCT. An initialized source
  returns the same fixed `404 not_found` for absent organizations and Agents;
  a Runtime revision mismatch is `409 configuration_conflict`. Readiness or
  storage failure is an error, never a successful null barrier. A non-null
  receipt retains its original Runtime execution identity across ACP restart.
  The query neither clears protection nor triggers Rebuild. Controller's
  configured automatic policy can admit one durable Rebuild for the original
  barrier; the default policy remains manual. The automatic kill-during-tool
  integration verifies Runtime replacement and a new Run. Notification and
  manual UI recovery consumers remain pending.
- An unconfirmed Run admission write stops the affected generation's admission
  in registered owner mode; legacy/global failures require service recovery.
  An unacknowledged prompt returns JSON-RPC `-32603`
  with `code: database_error` and `retryable: false`; its public message contains
  no database details. The original cause remains available to internal
  diagnostics. ACP does not invent a new outcome.
  Startup classifies legacy work without repeating model or Tool work and
  isolates protected owned work.
  Component coverage uses production service composition and real PostgreSQL
  with fake outbound Runtime/model peers in
  [`persistence-faults.postgres.test.ts`](../../../tests/integration/agent-acp-service/e2e/persistence-faults.postgres.test.ts).
- Run-event or terminal acknowledgement loss retries the identical write up to
  three times. Exhaustion isolates that Run's Agent while scoped recovery
  reads durable state; healthy Agents continue in the same service instance.
  Recovery retains the busy slot and Runtime pin until an outcome is confirmed.
  It does not replay model or Tool effects, and a missing row is not a successful
  recovery. Committed terminal results are returned unchanged. Event failure
  closes undispatched calls and records `persistence_interrupted`; unknown
  effects or temporary cleanup failure remain unresolved and retain their barrier.
  Recovery retries use 250 ms to 5 s backoff plus jitter and stop on worker
  ownership loss or shutdown. Admission uncertainty uses the mode-specific path
  above; predecessor stop-proof recovery remains pending for protected owned work.
- Run worker lock unavailable: startup fails because another replica owns Run
  execution. A same-session heartbeat detects loss of the dedicated lock
  connection; loss immediately closes admission, clears readiness and cancels
  startup recovery and local execution. It establishes the same absolute
  configured shutdown deadline as the first SIGTERM/SIGINT. `main` retains the
  original startup and one shutdown operation until actual completion;
  repeated signals neither create another shutdown nor reset the deadline.
  Service failure notifications remain observed during closure, and late
  errors from original tasks are retained. Business errors are recorded before
  telemetry flush. The ownership-loss telemetry flush starts after cleanup,
  has a 500ms maximum and remains bounded by the overall deadline's remaining
  time. Actual expiry forces a non-zero exit without claiming successful joins.
  External and durable operations, including context checkpoint writes,
  recheck ownership after success or failure before any next transition; a
  stale worker cannot persist terminal Run state after losing authority.
  Agent-local ownership loss still closes only that Agent, and the global
  worker lock remains required. The real PostgreSQL/main startup regression
  holds the configuration read through lock loss and repeated SIGTERM, then
  verifies cleanup after release or hard exit at the original deadline. The
  latter is not proof of successful SQL completion. See
  [`main-worker-loss.postgres.test.ts`](../../../tests/integration/agent-acp-service/e2e/main-worker-loss.postgres.test.ts).
  The separate [Learning lifecycle component test](../../../tests/integration/agent-acp-service/e2e/learning-lifecycle.postgres.test.ts)
  holds real Provider transport cleanup during legacy/owned shutdown and Agent A
  lease loss while B completes a foreground Run. It does not establish B's
  background claim recovery, predecessor stop-proof handling or two replicas.
  Injected internal transport-close failures remain visible in the shutdown
  result, including after cancellation or an HTTP 503. Shared resource cleanup
  still completes; another Agent can run before and after the failed close.
- Session cancellation, close, or delete: persist a cancellation latch before
  waiting for in-memory execution. A late acceptance commit reaches an already
  aborted executor and is closed without starting model or Tool work.
- SIGTERM/SIGINT: immediately close admission and establish the shared absolute
  deadline from the configured shutdown timeout. Retain the original startup
  and single shutdown, cancel active work, terminate ACP transports, persist
  terminal or unresolved facts only under live authority, and release the
  worker lock and database pool. Repeated signals do not extend the deadline.
  Failure notifications and late original-task errors remain recorded before
  telemetry flush. Incomplete cleanup exits non-zero; actual deadline expiry
  forces exit without establishing successful joins.
- ACP reconnect: active Run ownership remains in the process-level supervisor;
  an authorized `session/cancel`, close, or delete from a replacement
  connection still reaches the original Run.

All database transactions that lock both records use the canonical
Session-before-Run order. Cancellation, Session lifecycle changes, Run
admission, and durable event persistence must not introduce the inverse order.

## Deployment Boundary

The service is internal. Do not publish its port directly to the internet.
Compose or Kubernetes network policy permits:

- workspace inbound only from authenticated Agent UI, Console and
  Registry on their documented routes; Controller uses its separate listener;
- outbound to authenticated Identity for bounded JWKS verification;
- outbound to its private PostgreSQL, configured model APIs,
  the Runtime MCP endpoint in a Run snapshot and that Runtime's private
  Skill maintenance and temporary-Skill endpoints;
- outbound to Agent Controller's internal Skill learning policy endpoint and the
  Skill Registry internal API, only when those optional features are configured;
- inbound from Skill Registry to `/internal/skill-sources/*` when Skill
  discovery is configured.
