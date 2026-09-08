# ACP Protocol Conformance

## Purpose

This document defines ACP tests from the protocol inward. It must not infer
conformance from the methods that happen to exist in the implementation.

The pinned authority is `@agentclientprotocol/sdk` `1.4.0`:

- package root and `schema/schema.json`: stable ACP v1;
- `experimental/v2` and `schema/v2/schema.unstable.json`: draft ACP v2.

A protocol surface is conformant only when all baseline requirements and every
advertised optional capability have executable positive evidence. Optional
capabilities that are not advertised are not implementation gaps, but selected
negative tests must prove that the Agent does not accidentally expose them.

## Coverage States

| State                 | Meaning                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Covered               | An executable project test proves the protocol behavior.                                                                        |
| Layer-covered         | Lower-layer tests prove the business rule, but no wire test closes it.                                                          |
| Service-covered       | Real wire and owned persistence prove the rule with deterministic dependency ports; full-platform acceptance is still separate. |
| Missing test          | The implementation exists without the required protocol evidence.                                                               |
| Intentional deviation | A mandatory protocol capability is deliberately excluded by the product profile; full conformance is not claimed.               |
| Out of scope          | Optional capability is not advertised and is intentionally not exposed.                                                         |

Passing SDK serialization is necessary but insufficient. The matrix separately
tests capability honesty, handler semantics, wire framing, authorization,
durability, and recovery.

## V1 Verification Batch (2026-09-08)

### Approved Platform-Only MCP Profile

Both ACP versions retain the standard `mcpServers` input but accept only `[]`.
Every nonempty list is rejected with `client_mcp_not_allowed`, before any
configuration write, replay, process launch or client MCP connection. Neither
endpoint advertises HTTP, SSE or MCP-over-ACP input capabilities. Tools come
only from the platform Runtime MCP, including its managed stdio children.
Persisted client sources must also be rejected by the execution catalog.

Stable v1 requires client stdio MCP. Our deliberate restriction therefore
remains a protocol deviation, not a claim of generic full v1 conformance and
not an obligation to implement client proxies in this closeout. Retained MCP
revision records remain part of historical Run snapshots; schema removal is
not part of this service-owned interface verification batch.

### Verification Scope

Stable v1 is the primary acceptance line. The official
[initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[Session deletion](https://agentclientprotocol.com/protocol/v1/session-delete),
and [transport](https://agentclientprotocol.com/protocol/v1/transports) contracts
were checked against the pinned SDK, not inferred from v2 or another Agent.
`session/fork` remains an advertised draft extension, not a v1 baseline method.
The SDK's package version is not the negotiated protocol version.

The batch stays inside Agent ACP Service. It verifies real WebSocket requests
against its own PostgreSQL database with deterministic Controller/model/Tool
ports. It does not repeat Gateway/Identity Docker acceptance or introduce a
Goose-compatible private API. The batch checks:

- initialization negotiation and pre-initialization rejection of every supported
  Session request, with no application invocation;
- persisted list pagination/metadata, load-before-response ordering, resume
  without history, independent fork, close/restore, and deletion/retention;
- cancellation of a running Prompt and successful subsequent use;
- rejection of unadvertised methods, unsupported workspaces and content, without
  accepting a Prompt or changing persisted configuration;
- idempotent deletion of missing/already-deleted Sessions while retaining owner
  checks for existing Sessions, including deleted foreign Sessions.

### Final Service Metrics

Acceptance on 2026-09-08: 215 unit/component tests (31 files), all 53
PostgreSQL cases (7 files), the production TypeScript build, root
`make fmt-check` and `make lint` passed. PostgreSQL used one dedicated database
in the existing development instance; that database was removed afterward.
No external Provider or client MCP host was contacted. Existing Docker services
were not rebuilt, so this is service-boundary acceptance, not a fresh
Gateway/Runtime/Jaeger integration run.

### Goose Reference Boundary

Reference checkout: `references/goose` at `5e90925` (2026-09-05), Rust ACP
schema `1.5.0`, SDK source `c97a5203d3392f7f231514d84eea014f9f43e6fb`.
This is an implementation reference, not a second protocol authority.

| Goose implementation                                               | Relevant lesson / Antnest decision                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/goose/src/acp/server.rs::serve` and `GooseAgentConnection` | stdio and remote connections share `GooseAcpHandler`; Antnest similarly keeps transport mapping separate from the application                              |
| `crates/goose/src/acp/transport/mod.rs::create_acp_router_inner`   | `serve` uses the official HTTP server for `/acp`; Antnest currently exposes WebSocket only, not Goose's POST/GET/DELETE Streamable HTTP surface            |
| `crates/goose/src/acp/server_factory.rs::AcpServer`                | Connection state and shared active Runs have different lifetimes; Antnest persists Sessions/Runs and keeps connection identity separate                    |
| `crates/goose/src/acp/server.rs::mcp_server_to_extension_config`   | Goose launches client stdio locally; Antnest must not copy that onto its shared ACP host. Runtime-managed stdio is a separate source                       |
| `crates/goose/src/acp/server/dispatch.rs`                          | Baseline requests, negotiated client callbacks and `_goose/*` extensions are distinct; private Provider/recipe/steer/scheduler APIs are not v1 obligations |

WebSocket is a documented custom v1 transport, which v1 permits; it is not
evidence of implementing the draft Streamable HTTP transport. ACP transport
stdio and client-supplied **MCP** stdio are two different questions.

## Stable ACP v1 Matrix

| ID              | Protocol contract                                                                                                    | Current evidence                                                       | State                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| V1-INIT-01      | `initialize` returns supported v1 for requested 0/1/2/99; truthful capabilities                                      | `acp-v1-agent.test.ts`                                                 | Covered                   |
| V1-INIT-02      | All eight supported Session requests reject before initialize; initialize only once                                  | `acp-v1-agent.test.ts`                                                 | Covered                   |
| V1-NEW-01       | `session/new` creates an owned Session with workspace and empty MCP revision                                         | `acp-v1-lifecycle.postgres.test.ts`, `acp-mcp-input.postgres.test.ts`  | Service-covered           |
| V1-LOAD-01      | `session/load` replays ordered durable user/usage/Tool/assistant updates before response                             | `acp-v1-lifecycle.postgres.test.ts`, `acp-happy-path.postgres.test.ts` | Service-covered           |
| V1-LIST-01      | `session/list` scopes ownership and paginates 52 Sessions without duplicates                                         | `acp-v1-lifecycle.postgres.test.ts`                                    | Service-covered           |
| V1-DELETE-01    | `session/delete` is idempotent for missing/deleted records, hides from list, retains history and ownership checks    | `session-service.test.ts`, `acp-v1-lifecycle.postgres.test.ts`         | Service-covered           |
| V1-FORK-01      | Advertised draft `session/fork` copies context with new identities, no Run execution, independent subsequent history | `acp-v1-lifecycle.postgres.test.ts`                                    | Service-covered           |
| V1-RESUME-01    | `session/resume` reactivates without historical replay and accepts a new Prompt                                      | `acp-v1-lifecycle.postgres.test.ts`                                    | Service-covered           |
| V1-CLOSE-01     | `session/close` retains list/history, rejects Prompt until load/resume                                               | `acp-v1-lifecycle.postgres.test.ts`                                    | Service-covered           |
| V1-PROMPT-01    | Prompt blocks until terminal Run outcome and returns its stable stop reason                                          | adapter terminal tests + `acp-v1-lifecycle.postgres.test.ts`           | Service-covered           |
| V1-CONTENT-01   | Text/resource links and advertised image/resource work; undeclared audio/image reject without admission              | `acp-v1-agent.test.ts`, `acp-v1-lifecycle.postgres.test.ts`            | Service-covered           |
| V1-CANCEL-01    | Notification settles running Prompt as cancelled; next Prompt succeeds                                               | `acp-v1-lifecycle.postgres.test.ts`                                    | Service-covered           |
| V1-UPDATE-01    | Message/thought/Tool/usage map in order; persisted transcript replays faithfully                                     | adapter update tests + `acp-v1-lifecycle.postgres.test.ts`             | Service-covered           |
| V1-ERROR-01     | Invalid initialization/params, failed/unresolved Runs and unknown methods retain distinct errors                     | adapter + raw-wire + lifecycle tests                                   | Covered                   |
| V1-MCP-01       | Nonempty HTTP/stdio/SSE/MCP-over-ACP input is rejected at every setup method, with no partial writes or replay       | `acp-mcp-input.postgres.test.ts`                                       | Service-covered           |
| V1-MCP-STDIO-01 | Generic v1 Agents must support client stdio MCP                                                                      | Explicit platform-only profile above                                   | **Intentional deviation** |

This is a restricted v1 Session service, not a generic fully conformant Agent.
Platform-managed stdio children are reached through Runtime; they do not
implement the client-supplied stdio field. No client-side MCP proxy is planned
under this product boundary. See [Runtime context](runtime-context.md).

`session/delete` follows v1's SHOULD-level idempotency guidance. An existing
foreign Session still fails ownership checks, even after deletion. Retention
does not grant access, and idempotency does not mean ignoring arbitrary errors.

`session/update` is the Agent-to-client callback. Filesystem, terminal,
permission and elicitation callbacks require client-owned capabilities and are
not used: platform Runtime tools perform execution. Provider/mode/editor/NES
surfaces are optional or draft/private, not missing required baseline methods.

## Draft ACP v2 Matrix

| ID            | Protocol contract                                                                   | Current evidence                         | State           |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- | --------------- |
| V2-INIT-01    | Official SDK enforces initialize-before-use, initialize-once, and capability shape. | initialization tests                     | Covered         |
| V2-NEW-01     | Baseline `session/new` maps workspace and complete MCP configuration.               | lifecycle and HTTP stream tests          | Covered         |
| V2-LIST-01    | Baseline `session/list` maps filters, metadata, and pagination.                     | lifecycle mapping test                   | Covered         |
| V2-RESUME-01  | Baseline `session/resume` supports no replay cursor and `start`.                    | replay tests                             | Covered         |
| V2-RESUME-02  | Unknown extension replay cursors are rejected rather than guessed.                  | unknown-cursor test                      | Covered         |
| V2-CLOSE-01   | Baseline `session/close` reaches the authorized application operation.              | lifecycle mapping test                   | Covered         |
| V2-DELETE-01  | Advertised `session/delete` reaches the authorized application operation.           | lifecycle mapping test                   | Covered         |
| V2-FORK-01    | Advertised experimental `session/fork` maps the complete request.                   | fork mapping test                        | Covered         |
| V2-PROMPT-01  | Prompt response ACK precedes every update on both memory and WebSocket transports.  | adapter and raw-wire ordering tests      | Covered         |
| V2-CONTENT-01 | Baseline and advertised prompt blocks work; undeclared audio rejects.               | prompt-content tests                     | Covered         |
| V2-CANCEL-01  | Semantic `session/cancel` settles execution before terminal idle.                   | same- and replacement-connection tests   | Covered         |
| V2-UPDATE-01  | User, agent, thought, Tool, usage, Session info, running, and idle map in order.    | update mapping tests                     | Covered         |
| V2-MCP-01     | No client MCP capability advertised; nonempty inputs reject across new/resume/fork  | adapter + PostgreSQL MCP input tests     | Service-covered |
| V2-BATCH-01   | WireStream accepts valid batches and preserves per-entry JSON-RPC responses.        | mixed request/notification raw-wire test | Covered         |

The only standardized v2 replay cursor in SDK `1.4.0` is `start`. Other values
are extension cursors whose documented safe behavior is preservation or
rejection. They must not be treated as a missing standardized message cursor.

`$/cancel_request` permits, but does not require, the receiver to abort the
underlying operation. A normal response remains conformant. Semantic Run
cancellation is carried by `session/cancel` and is mandatory for this service.

## Transport And Boundary Matrix

| ID      | Contract                                                              | Current evidence              | State         |
| ------- | --------------------------------------------------------------------- | ----------------------------- | ------------- |
| WIRE-01 | Only exact `/v1/acp` and `/v2/acp` WebSocket routes are exposed.      | HTTP server tests             | Covered       |
| WIRE-02 | Readiness is checked before Agent access resolution.                  | HTTP server tests             | Covered       |
| WIRE-03 | Missing subject is 401; rejected subject is 403 for both versions.    | HTTP server tests             | Covered       |
| WIRE-04 | Malformed JSON returns JSON-RPC `-32700` and the connection survives. | raw-wire test                 | Covered       |
| WIRE-05 | Binary messages close with WebSocket code 1003.                       | raw-wire test                 | Covered       |
| WIRE-06 | Payloads beyond the configured maximum close with code 1009.          | raw-wire test                 | Covered       |
| WIRE-07 | Shutdown terminates open transports deterministically.                | HTTP server test              | Covered       |
| WIRE-08 | JSON-RPC IDs are preserved and unknown methods return `-32601`.       | both version raw-wire tests   | Covered       |
| WIRE-09 | v2 initialize is the only item in its batch.                          | raw-wire batch rejection test | Covered       |
| WIRE-10 | ACP `_meta` trace context reaches application/model/MCP spans.        | telemetry unit tests          | Layer-covered |

## Unadvertised Optional Surfaces

Authentication, Provider administration, Session modes/configuration,
MCP-over-ACP, permissions, elicitation, NES, document synchronization, and ACP
client filesystem/terminal delegation are not advertised by this service.
They are out of scope rather than missing functionality. Parameterized raw
JSON-RPC tests prove that an unadvertised request returns `-32601` without
closing the connection (`OPTIONAL-NEGATIVE-01`).

## Cross-Layer Evidence Still Required

### Service-Owned Batch: Access And MCP Input Boundaries

Tests run through both real WebSocket endpoints and the owned PostgreSQL
repositories, using deterministic Agent Controller/model/Tool ports. The
application, Session authorization, Run admission coordinator, and protocol
adapters are real, not mocked application handlers.

1. A different principal on the same Agent and the same principal on a
   different Agent cannot list, replay, fork, prompt, close, delete or cancel
   the owner's Session. Rejections expose no message/Tool content and leave
   the owner's history, MCP revision and lifecycle unchanged. Session ownership
   is checked before exposing an in-memory busy state; admission still checks
   the current Session state before creating an intent.
2. An already-connected client whose access revision changes or whose
   principal/Agent authorization is revoked cannot start new work or manage
   Sessions. This is not browser-token or individual transport-subject revocation;
   those require Gateway integration. Prompt rejection may
   retain a failed admission intent, but not an accepted message, model call,
   Tool call or leaked admission. A fresh authorized connection can resume.
3. All nonempty client MCP lists reject at every configuration-bearing method,
   for active and closed Sessions with history. Rejection preserves persistence,
   sends no replay, performs no model/Tool call and acquires no Run admission.
   Empty lists preserve Session/fork identity boundaries and immutable revisions.
4. The execution catalog separately rejects retained client sources and
   client-source Tool calls without outbound dispatch. Runtime tools, managed
   stdio tools, execution fencing and uncertain-effect handling remain covered.

These tests prove service wire/persistence semantics only. The separate Docker
acceptance below proves selected real Gateway, Identity, Runtime and process
recovery paths; this batch does not rerun or broaden those claims.

These cases test product semantics rather than protocol serialization. They are
required before a production conformance claim:

| ID              | Scenario                                                                        | State           |
| --------------- | ------------------------------------------------------------------------------- | --------------- |
| E2E-V1-01       | v1 WebSocket + PostgreSQL Prompt, Tool updates, stop reason, reconnect/load.    | Covered         |
| E2E-V2-01       | v2 WebSocket + PostgreSQL happy path.                                           | Covered         |
| E2E-AUTH-01     | Cross-principal and cross-Agent Session access never leaks or mutates.          | Covered         |
| E2E-IDENTITY-01 | Owner deactivation rejects work on an existing Gateway connection.              | Covered         |
| E2E-STALE-01    | Access revision changes invalidate an existing connection before work.          | Service-covered |
| E2E-RECOVERY-01 | Disconnect/restart/resume replays once without repeating model or Tool effects. | Layer-covered   |
| E2E-RUNTIME-01  | Run A retains its captured Runtime; Run B obtains the next revision.            | Layer-covered   |

`test/e2e/acp-happy-path.postgres.test.ts` covers E2E-V1-01 using real
WebSockets, the official v1 client, and PostgreSQL. It verifies stable message
identities and Tool history across reconnection and repeated load without
another model call, Tool call, or Run admission. A separate case reconstructs
the application, repositories, and HTTP server against the same database and
encryption key before load. Controller, model, and Tool ports are deterministic
stubs. This service suite is not Gateway/Runtime integration or an OS-process
crash test; the separate Docker profile below adds those dependencies.

`test/e2e/acp-access.postgres.test.ts` adds 16 cases across v1/v2 for Session
ownership, access-revision changes, principal deactivation and active-Run
protection. Cancellation is a notification: rejected cancellation must not emit
a response or prevent a subsequent request on the connection. Replay assertions
inspect only newly received frames; model, Tool and admission counts must not
increase from replay or unauthorized operations.

`test/e2e/acp-mcp-input.postgres.test.ts` has twelve cases across v1/v2.
HTTP, stdio, SSE and MCP-over-ACP are rejected separately at every setup method,
on active and closed Sessions with history. Empty-list lifecycle cases preserve
immutable revisions and fork isolation. Retained client revisions reject before
Run admission; empty load/resume restores platform-only execution without
rewriting history. These prove the platform-only profile,
not v1's mandatory stdio support.

`test/e2e/acp-v1-lifecycle.postgres.test.ts` adds ten cases for persisted
ordering, pagination, fork independence, close/restore, idempotent deletion,
cancellation/reuse, optional-method rejection and workspace/content validation.
Its expected transcript includes usage updates for each model response, not
only chat text. Controller/model/Tool ports remain deterministic substitutes.

The shared Controller fixture separates transport-subject mapping from current
principal/Agent authorization. These cases do not test browser-token revocation
or a real Identity Service, and do not settle individual subject revocation
without an access-revision change. Gateway closeout retains those distinctions.

### Gateway And Process Recovery Acceptance

`ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3` runs the
[closeout integration](../../../scripts/acp-closeout/README.md). Edge exposes
`/api/app/agents/{agent_id}/v1/acp` and `/api/app/agents/{agent_id}/v2/acp`;
the existing unversioned Workspace route remains a v1 alias. Both use identical
authenticated upgrade admission, same-origin checks and authoritative subject
injection. Neither version accepts client-selected private routing fields.

Acceptance on 2026-09-07 passed both official SDK clients through real Gateway,
Identity, Controller, ACP, PostgreSQL and Runtime services. Two independent
users and three Agents exercise foreign upgrades, foreign Session operations
and deactivation on an already-open connection. Every rejected operation
preserves Session/history/Tool/MCP records; a rejected prompt may retain exactly
one failed admission intent with no accepted prompt or execution snapshot.

Six SIGKILL/restart cycles cover completed history, an outstanding first model
response, and a completed Bash effect before the next model response. Recovery
preserves durable messages and confirmed Tool results, closes interrupted
admissions and permits a new prompt. Replay checks message identities, types,
content, unified message/Tool order and v2 `idle/end_turn` or `idle/_failed`.
Repeated replay performs no model/Tool calls; its legitimate new MCP revision
is checked separately from unchanged execution records. An append log read
through Runtime confirms effects were not repeated.

Final metrics: 20 deterministic model requests, six real Runtime Tool calls,
six verified process restarts and ten fixture/oracle tests. Two completed
baseline Jaeger traces (204 spans total) verify Gateway ancestry through
Identity, Controller, ACP context/catalog/model and Runtime MCP. Crash-time
unexported spans are not claimed. The disposable project and checkpoints were
removed, not retained as a collection of intermediate evidence files.

E2E-RECOVERY-01 remains layer-covered: uncertain in-flight Tool effects,
AcquireRun/FinishRun response-loss windows and active-Run rebuild still need
full-platform acceptance. E2E-STALE-01 still has service-only revision-change
evidence. User deactivation is not proof of browser logout/expiry revocation
on an already-upgraded connection. Full ACP conformance is not claimed.

Service acceptance (2026-09-07): 200 unit/component tests, all 37 PostgreSQL
cases, the production TypeScript build, `make fmt-check` and `make lint` passed.
PostgreSQL tests used one dedicated test database in the existing shared
instance. The old worker-lock fault test selected a PID from cluster-wide locks
and could terminate a worker
in another database. It now targets the exact test-owned PoolClient, waits
boundedly for loss, and releases locks in `finally`. This is a test-safety fix,
not a diagnosis of the separate idle-container CPU concern.

The [managed MCP integration](../../../docs/runtime-context-and-managed-mcp.md)
adds real Gateway/Controller/Runtime create/chat/rebuild and causal Jaeger
evidence, using a deterministic model. It proves that the same Session uses
the newly published Runtime after explicit rebuild. It does not exercise a
process crash, concurrent identities, or rebuild requested while a Run is in flight;
the full-platform scenarios E2E-RECOVERY-01, E2E-AUTH-01, E2E-STALE-01 and
E2E-RUNTIME-01 are therefore not accepted by that integration alone.

## Current Verdict

- Stable v1 is the primary line; the supported Session surface has adapter and
  real WebSocket/PostgreSQL evidence. Draft v2 remains a separate adapter.
- All client MCP injection is deferred and no corresponding optional
  capability is advertised. Future administrator authorization applies to
  client injection as a whole, as defined in the [trust policy](client-mcp-policy.md).
  The mandatory-v1-stdio deviation is explicit.
- Existing Gateway isolation, selected restart recovery and Jaeger evidence
  remain valid within their named scenarios above, not universal guarantees.
- Remaining full-platform acceptance is tracked by
  [the single-node closeout](../../../docs/docker-single-node-closeout.md);
  the service-only evidence here does not replace those named profiles.
- This is Antnest's restricted ACP profile, not a claim of full generic ACP
  conformance or completion of every C1 integration acceptance point.
