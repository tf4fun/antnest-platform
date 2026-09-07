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

| State           | Meaning                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Covered         | An executable project test proves the protocol behavior.                                                                        |
| Layer-covered   | Lower-layer tests prove the business rule, but no wire test closes it.                                                          |
| Service-covered | Real wire and owned persistence prove the rule with deterministic dependency ports; full-platform acceptance is still separate. |
| Missing test    | The implementation exists without the required protocol evidence.                                                               |
| Product gap     | A baseline or advertised protocol requirement is not implemented.                                                               |
| Out of scope    | Optional capability is not advertised and is intentionally not exposed.                                                         |

Passing SDK serialization is necessary but insufficient. The matrix separately
tests capability honesty, handler semantics, wire framing, authorization,
durability, and recovery.

## Stable ACP v1 Matrix

| ID              | Protocol contract                                                                   | Current evidence                           | State           |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| V1-INIT-01      | `initialize` negotiates v1 and reports exact implementation and capabilities.       | `acp-v1-agent.test.ts` capability test     | Covered         |
| V1-INIT-02      | No Session request is accepted before initialize; initialize occurs only once.      | `enforces one initialize request...`       | Covered         |
| V1-NEW-01       | `session/new` maps workspace and the complete MCP list and returns a Session ID.    | lifecycle mapping and HTTP stream tests    | Covered         |
| V1-LOAD-01      | `session/load` replays durable history in order before returning.                   | load/resume adapter test                   | Covered         |
| V1-LIST-01      | `session/list` maps filters, cursor, metadata, and next cursor.                     | lifecycle mapping test                     | Covered         |
| V1-DELETE-01    | Advertised `session/delete` reaches the authorized application operation.           | lifecycle mapping test                     | Covered         |
| V1-FORK-01      | Advertised experimental `session/fork` maps source and replacement Session inputs.  | fork mapping test                          | Covered         |
| V1-RESUME-01    | `session/resume` restores without replaying old history.                            | load/resume adapter test                   | Covered         |
| V1-CLOSE-01     | Advertised `session/close` reaches the authorized application operation.            | lifecycle mapping test                     | Covered         |
| V1-PROMPT-01    | Prompt blocks until terminal Run outcome and returns its stable stop reason.        | blocking Prompt and terminal-outcome tests | Covered         |
| V1-CONTENT-01   | Text and resource links always work; advertised image/resource work; audio rejects. | prompt-content test                        | Covered         |
| V1-CANCEL-01    | `session/cancel` reaches cancellation and Prompt returns `cancelled` after settle.  | cancellation-settle test                   | Covered         |
| V1-UPDATE-01    | Message, thought, Tool create/update, usage, and Session info map in order.         | update mapping tests                       | Covered         |
| V1-ERROR-01     | Invalid request/params and terminal failed/unresolved retain stable error codes.    | initialization, content, terminal tests    | Covered         |
| V1-MCP-HTTP-01  | Advertised HTTP MCP configuration crosses the protocol boundary intact.             | lifecycle mapping test                     | Covered         |
| V1-MCP-STDIO-01 | Every v1 Agent supports stdio MCP as required by the stable schema.                 | `domain/mcp.ts` rejects non-HTTP sources   | **Product gap** |

The service therefore remains a stable-v1 Session adapter with a known MCP
baseline incompatibility, not a fully conformant ACP v1 Agent. Single-node
closeout deliberately supports only Streamable HTTP MCP at the ACP client-input
boundary. Platform-configured stdio children are supported inside Runtime and
reached through its aggregated HTTP MCP surface; that is not support for the
client-supplied stdio field in `session/new` or `session/load`. Client-injected
stdio and legacy SSE remain outside this delivery. The Product gap state above
records the protocol difference, not permission to erase it from conformance
reporting. Executing an arbitrary client command inside Agent ACP Service is
not an acceptable shortcut. See [Runtime context](runtime-context.md).

## Draft ACP v2 Matrix

| ID             | Protocol contract                                                                   | Current evidence                         | State   |
| -------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- | ------- |
| V2-INIT-01     | Official SDK enforces initialize-before-use, initialize-once, and capability shape. | initialization tests                     | Covered |
| V2-NEW-01      | Baseline `session/new` maps workspace and complete MCP configuration.               | lifecycle and HTTP stream tests          | Covered |
| V2-LIST-01     | Baseline `session/list` maps filters, metadata, and pagination.                     | lifecycle mapping test                   | Covered |
| V2-RESUME-01   | Baseline `session/resume` supports no replay cursor and `start`.                    | replay tests                             | Covered |
| V2-RESUME-02   | Unknown extension replay cursors are rejected rather than guessed.                  | unknown-cursor test                      | Covered |
| V2-CLOSE-01    | Baseline `session/close` reaches the authorized application operation.              | lifecycle mapping test                   | Covered |
| V2-DELETE-01   | Advertised `session/delete` reaches the authorized application operation.           | lifecycle mapping test                   | Covered |
| V2-FORK-01     | Advertised experimental `session/fork` maps the complete request.                   | fork mapping test                        | Covered |
| V2-PROMPT-01   | Prompt response ACK precedes every update on both memory and WebSocket transports.  | adapter and raw-wire ordering tests      | Covered |
| V2-CONTENT-01  | Baseline and advertised prompt blocks work; undeclared audio rejects.               | prompt-content tests                     | Covered |
| V2-CANCEL-01   | Semantic `session/cancel` settles execution before terminal idle.                   | same- and replacement-connection tests   | Covered |
| V2-UPDATE-01   | User, agent, thought, Tool, usage, Session info, running, and idle map in order.    | update mapping tests                     | Covered |
| V2-MCP-HTTP-01 | Advertised HTTP MCP configuration crosses the protocol boundary intact.             | lifecycle mapping test                   | Covered |
| V2-BATCH-01    | WireStream accepts valid batches and preserves per-entry JSON-RPC responses.        | mixed request/notification raw-wire test | Covered |

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
3. Stdio and legacy SSE inputs are rejected at every Session method accepting
   MCP configuration. Rejected create/fork/load/resume must not partially
   persist or replace configuration. Valid HTTPS MCP still round-trips through
   encrypted persistence, including headers; Runtime-managed children remain
   a separate platform-owned source.

These tests close service wire/persistence gaps only. Real Gateway identity
resolution, OS-process interruption and cross-service Jaeger acceptance remain
separate integration work. Do not upgrade the full-platform verdict from this
batch's results.

These cases test product semantics rather than protocol serialization. They are
required before a production conformance claim:

| ID              | Scenario                                                                        | State           |
| --------------- | ------------------------------------------------------------------------------- | --------------- |
| E2E-V1-01       | v1 WebSocket + PostgreSQL Prompt, Tool updates, stop reason, reconnect/load.    | Covered         |
| E2E-V2-01       | v2 WebSocket + PostgreSQL happy path.                                           | Covered         |
| E2E-AUTH-01     | Cross-principal and cross-Agent Session access never leaks or mutates.          | Service-covered |
| E2E-STALE-01    | Access revision changes invalidate an existing connection before work.          | Service-covered |
| E2E-RECOVERY-01 | Disconnect/restart/resume replays once without repeating model or Tool effects. | Missing test    |
| E2E-RUNTIME-01  | Run A retains its captured Runtime; Run B obtains the next revision.            | Layer-covered   |

`test/e2e/acp-happy-path.postgres.test.ts` covers E2E-V1-01 using real
WebSockets, the official v1 client, and PostgreSQL. It verifies stable message
identities and Tool history across reconnection and repeated load without
another model call, Tool call, or Run admission. A separate case reconstructs
the application, repositories, and HTTP server against the same database and
encryption key before load. Controller, model, and Tool ports are deterministic
stubs. This is not Gateway/Runtime integration or an OS-process crash test;
E2E-RECOVERY-01 still requires actual process interruption, including in-flight
work, and remains open.

`test/e2e/acp-access.postgres.test.ts` adds 16 cases across v1/v2 for Session
ownership, access-revision changes, principal deactivation and active-Run
protection. Cancellation is a notification: rejected cancellation must not emit
a response or prevent a subsequent request on the connection. Replay assertions
inspect only newly received frames; model, Tool and admission counts must not
increase from replay or unauthorized operations.

`test/e2e/acp-mcp-input.postgres.test.ts` adds six cases across v1/v2. Rejection
uses a valid HTTPS prefix followed by stdio/SSE, for each setup method, on both
active and closed Sessions with history. No partial configuration, activation
or replay is allowed. Positive setup uses different credentials per method,
checks immutable historical revisions and verifies fork isolation. This proves
the declared HTTP-only input profile, not support for v1's mandatory stdio.

The shared Controller fixture separates transport-subject mapping from current
principal/Agent authorization. These cases do not test browser-token revocation
or a real Identity Service, and do not settle individual subject revocation
without an access-revision change. Gateway closeout retains those distinctions.

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

- ACP v1 required and advertised Session methods: implemented and directly
  exercised.
- ACP v2 baseline and advertised Session methods: implemented and directly
  exercised.
- Capability honesty: correct for optional ACP surfaces; v1 stdio MCP remains a
  baseline incompatibility.
- Wire protocol: core framing, payload limits, authentication, unknown methods,
  v2 batch including initialize exclusivity, and Prompt ordering are covered.
- Durable business semantics: stable v1 WebSocket/PostgreSQL reconnect/load
  and v1/v2 Session authorization/input-boundary coverage exists; real-Gateway
  isolation and interrupted-process recovery remain open.

Consequently, neither endpoint should be described as fully protocol-complete.
The accurate claim is: complete tested Session surface for the capabilities
Antnest advertises, with one known stable-v1 baseline gap and several wire/E2E
evidence gaps listed above.
