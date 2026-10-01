# ACP Protocol Conformance

This document defines how the Agent ACP Service is tested against the Agent
Client Protocol, from the protocol inward. Conformance is never inferred from
the methods that happen to exist in the implementation.

## Purpose

The pinned implementation schema is `@agentclientprotocol/sdk` `1.5.0`:

- package root and `schema/schema.json`: ACP v1, including experimental surfaces;
- `experimental/v2` and `schema/v2/schema.unstable.json`: draft ACP v2.

The official SDK's schema and capability-level stability annotations are the
authority. Website and RFD text is background when it differs from the SDK.
Check parent capability annotations, not just the export path or the absence of
an unstable label on a leaf type. The per-method SDK inventory is kept in
[`acp-v1-sdk-audit.json`](acp-v1-sdk-audit.json).

A protocol surface is conformant only when all baseline requirements and every
advertised optional capability have executable positive evidence. This is a
minimum conformance rule, not the service's product-completeness target.

The target is to implement all applicable stable ACP capabilities, including
optional ones. Only documented architecture incompatibilities and features
awaiting protocol stability are excluded or deferred. Clients select the
capabilities they use; a missing UI or a narrower client workflow does not
remove a capability from the server backlog. Sessions may select available
organization models and override Agent-default authorization behavior without
rewriting Agent defaults.

Unimplemented capabilities stay unadvertised and are explicitly rejected.
Negative tests prove that boundary, not completion of the missing capability.
Every exception records the specific surface, reason, source and revisit
condition. An unverified stability status remains pending review, not an
automatic deferral. Existing draft implementations keep their regression tests.

## Coverage States

| State                 | Meaning                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Covered               | An executable project test proves the protocol behavior.                                                                         |
| Layer-covered         | Lower-layer tests prove the business rule, but no wire test closes it.                                                           |
| Service-covered       | Real wire and owned persistence prove the rule with deterministic dependency ports; full-platform acceptance is still separate.  |
| Missing test          | The implementation exists without the required protocol evidence.                                                                |
| Intentional deviation | A mandatory protocol capability is deliberately excluded by the product profile; full conformance is not claimed.                |
| Implementation gap    | An applicable capability has no complete implementation; being optional or unadvertised does not close the gap.                  |
| Pending scope review  | Exact protocol status or architectural applicability still needs evidence; this is not an approved exclusion.                    |
| Awaiting stability    | A named proposal/draft surface is deferred with a source and revisit condition; existing implemented behavior remains tested.    |
| Architecture-excluded | A specific approved architectural incompatibility excludes the surface; mandatory exclusions also remain intentional deviations. |

Passing SDK serialization is necessary but insufficient. The matrices
separately test capability honesty, handler semantics, wire framing,
authorization, durability and recovery. Case-level coverage labels are not a
blanket protocol-completeness claim.

## Stable ACP v1 Matrix

The SDK audit regressions below were first reproduced as failures and now pass
as ordinary assertions, with no expected-failure or skipped tests:

| ID            | SDK requirement                                                              | Current evidence                                                                                | State           |
| ------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| V1-REFUSAL-02 | Refused user turn and following output must not enter the next model context | GAP-01 + PostgreSQL regressions cover load/resume/fork/restart, checkpoint and atomic migration | Service-covered |
| V1-CLOSE-02   | Close frees Session resources after cancelling work                          | GAP-02 + v1/v2 close/delete regressions cover all observers, pending attach and reopening       | Service-covered |
| V1-CANCEL-02  | Client cancellation returns cancelled even if underlying operations fail     | GAP-03 + HTTP Docker verify cancelled response, durable unknown effects and Runtime protection  | Service-covered |

| ID              | Protocol contract                                                                                                                            | Current evidence                                                                                                | State                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| V1-INIT-01      | `initialize` returns supported v1 for requested 0/1/2/99; truthful capabilities                                                              | `acp-v1-agent.test.ts`                                                                                          | Covered                   |
| V1-INIT-02      | All ten supported Session requests reject before initialize; initialize only once                                                            | `acp-v1-agent.test.ts`                                                                                          | Covered                   |
| V1-NEW-01       | `session/new` creates an owned Session with workspace and empty MCP revision                                                                 | `acp-v1-lifecycle.postgres.test.ts`, `acp-mcp-input.postgres.test.ts`                                           | Service-covered           |
| V1-LOAD-01      | `session/load` replays ordered durable user/usage/Tool/assistant updates before response                                                     | `acp-v1-lifecycle.postgres.test.ts`, `acp-happy-path.postgres.test.ts`                                          | Service-covered           |
| V1-LIST-01      | `session/list` scopes ownership and paginates 52 Sessions without duplicates                                                                 | `acp-v1-lifecycle.postgres.test.ts`                                                                             | Service-covered           |
| V1-DELETE-01    | `session/delete` is idempotent for missing/deleted records, hides from list, retains history and ownership checks                            | `session-service.test.ts`, `acp-v1-lifecycle.postgres.test.ts`                                                  | Service-covered           |
| V1-FORK-01      | Advertised draft `session/fork` copies context with new identities, no Run execution, independent subsequent history                         | `acp-v1-lifecycle.postgres.test.ts`                                                                             | Service-covered           |
| V1-RESUME-01    | `session/resume` reactivates without historical replay and accepts a new Prompt                                                              | `acp-v1-lifecycle.postgres.test.ts`                                                                             | Service-covered           |
| V1-CLOSE-01     | `session/close` retains list/history, rejects Prompt until load/resume                                                                       | `acp-v1-lifecycle.postgres.test.ts`                                                                             | Service-covered           |
| V1-PROMPT-01    | Prompt blocks until terminal Run outcome and returns its stable stop reason                                                                  | adapter terminal tests + `acp-v1-lifecycle.postgres.test.ts`                                                    | Service-covered           |
| V1-CONTENT-01   | Text, links and native image/audio/PDF follow actual model capabilities; unsupported input rejects without execution                         | `acp-v1-agent.test.ts`, `acp-multimodal.postgres.test.ts`                                                       | Service-covered           |
| V1-CANCEL-01    | Notification settles running Prompt as cancelled; next Prompt succeeds                                                                       | `acp-v1-lifecycle.postgres.test.ts`                                                                             | Service-covered           |
| V1-UPDATE-01    | Message/thought/Tool/usage map in order; persisted transcript replays faithfully                                                             | adapter update tests + `acp-v1-lifecycle.postgres.test.ts`                                                      | Service-covered           |
| V1-STREAM-01    | Stable message/thought IDs and chunks precede completion; progress and actual file facts replay without another Tool call                    | `acp-streaming.postgres.test.ts`, `acp-tool-progress.postgres.test.ts`, `acp-file-observation.postgres.test.ts` | Service-covered           |
| V1-CONFIG-01    | `session/set_config_option` and `session/set_mode` persist real model/mode choices, broadcast full configuration and apply at next admission | `acp-configuration.postgres.test.ts`                                                                            | Service-covered           |
| V1-PERMIT-01    | Agent-to-client `session/request_permission` controls actual dispatch for once/session allow/deny and cancellation                           | `acp-permissions.postgres.test.ts`                                                                              | Service-covered           |
| V1-PLAN-01      | Standard full-list `plan` replaces, clears, replays and forks the saved plan                                                                 | `acp-plan.postgres.test.ts`                                                                                     | Service-covered           |
| V1-COMMAND-01   | Setup emits `available_commands_update`; `/help` and `/帮助` run through ordinary Prompt without model/Runtime calls                         | `acp-commands.postgres.test.ts`                                                                                 | Service-covered           |
| V1-COST-01      | Standard `usage_update.cost` carries saved cumulative known amounts, excluding private receipts                                              | `acp-cost.postgres.test.ts`                                                                                     | Service-covered           |
| V1-INFO-01      | `session_info_update` shares persisted title/time across observers, setup/recovery and list                                                  | `acp-session-info.postgres.test.ts`, session-output unit and Docker regressions                                 | Service-covered           |
| V1-ERROR-01     | Invalid initialization/params, failed/non-cancellation unresolved Runs and unknown methods retain distinct errors                            | adapter + raw-wire + lifecycle tests                                                                            | Covered                   |
| V1-MCP-01       | Nonempty HTTP/stdio/SSE/MCP-over-ACP input is rejected at every setup method, with no partial writes or replay                               | `acp-mcp-input.postgres.test.ts`                                                                                | Service-covered           |
| V1-MCP-STDIO-01 | Generic v1 Agents must support client stdio MCP                                                                                              | Explicit platform-only profile above                                                                            | **Intentional deviation** |

This is a restricted v1 Session service, not a generic fully conformant Agent.
Platform-managed stdio children are reached through Runtime; they do not
implement the client-supplied stdio field. No client-side MCP proxy is planned
under this product boundary. See [Runtime context](runtime-context.md).

`session/delete` follows v1's SHOULD-level idempotency guidance. An existing
foreign Session still fails ownership checks, even after deletion. Retention
does not grant access, and idempotency does not mean ignoring arbitrary errors.

`session/update` is the Agent-to-client callback. Runtime-owned execution is the
approved alternative to delegating to client filesystem and terminal resources.
Permission and elicitation are separate human-interaction paths that Runtime
execution does not replace. Permission is implemented
([tool permissions](tool-permissions.md)); stable elicitation is deferred while
the official Runtime MCP SDK lacks the required URL support. Session
configuration is described in [session configuration](session-configuration.md).
Draft and private surfaces are classified individually; Provider, mode, editor
and NES surfaces are not excluded as one group.

## Draft ACP v2 Matrix

| ID            | Protocol contract                                                                                                                            | Current evidence                                                    | State           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------- |
| V2-INIT-01    | Official SDK rejects all eight registered Session requests before initialize without application calls; initialize-once and capability shape | `http-server.test.ts`, `acp-agent.test.ts`                          | Layer-covered   |
| V2-NEW-01     | `session/new` creates an owned workspace Session with empty client MCP; nonempty lists reject                                                | `acp-mcp-input.postgres.test.ts`                                    | Service-covered |
| V2-LIST-01    | `session/list` paginates 52 owned Sessions with metadata, no duplicate/missing/foreign entries                                               | dual-version `acp-v1-lifecycle.postgres.test.ts`                    | Service-covered |
| V2-RESUME-01  | Baseline `session/resume` supports no replay cursor and `start`.                                                                             | replay tests                                                        | Covered         |
| V2-RESUME-02  | Unknown extension replay cursors are rejected rather than guessed.                                                                           | unknown-cursor test                                                 | Covered         |
| V2-CLOSE-01   | Baseline `session/close` reaches the authorized application operation.                                                                       | lifecycle mapping test                                              | Covered         |
| V2-DELETE-01  | Advertised `session/delete` retains ownership checks and idempotent deletion                                                                 | dual-version `acp-v1-lifecycle.postgres.test.ts` cases              | Service-covered |
| V2-FORK-01    | Advertised `session/fork` copies context/configuration with independent later history                                                        | `acp-mcp-input.postgres.test.ts`                                    | Service-covered |
| V2-PROMPT-01  | Prompt response ACK precedes every update on both memory and WebSocket transports.                                                           | adapter and raw-wire ordering tests                                 | Covered         |
| V2-CONTENT-01 | Text, links and native image/audio/PDF use the actual configured model; unsupported input rejects                                            | `acp-multimodal.postgres.test.ts`                                   | Service-covered |
| V2-CANCEL-01  | Semantic `session/cancel` settles execution before terminal idle.                                                                            | same- and replacement-connection tests                              | Covered         |
| V2-UPDATE-01  | User/agent/thought messages, streamed chunks, Tool updates, usage and state retain version-specific ordering                                 | `acp-happy-path.postgres.test.ts`, `acp-streaming.postgres.test.ts` | Service-covered |
| V2-CONFIG-01  | `session/set_config_option` persists/broadcasts model and mode select, with restore and next-admission effect                                | `acp-configuration.postgres.test.ts`                                | Service-covered |
| V2-PERMIT-01  | Reverse `session/request_permission` responses control real Tool dispatch and cancellation                                                   | `acp-permissions.postgres.test.ts`                                  | Service-covered |
| V2-PLAN-01    | `plan_update` with current plan identity replaces/clears complete entries and survives replay/fork                                           | `acp-plan.postgres.test.ts`                                         | Service-covered |
| V2-COMMAND-01 | Setup command catalog and ordinary Prompt execution use official shapes                                                                      | `acp-commands.postgres.test.ts`                                     | Service-covered |
| V2-COST-01    | Reported/estimated known cost persists and replays without private receipts or double counting                                               | `acp-cost.postgres.test.ts`                                         | Service-covered |
| V2-INFO-01    | Session metadata uses persisted current values for live observers, restart/resume and fork                                                   | `acp-session-info.postgres.test.ts`, session-output unit tests      | Service-covered |
| V2-MCP-01     | No client MCP capability advertised; nonempty inputs reject across new/resume/fork                                                           | adapter + PostgreSQL MCP input tests                                | Service-covered |
| V2-BATCH-01   | WireStream accepts valid batches and preserves per-entry JSON-RPC responses.                                                                 | mixed request/notification raw-wire test                            | Covered         |

The only standardized v2 replay cursor in SDK `1.5.0` is `start`. Other values
are extension cursors whose documented safe behavior is preservation or
rejection. They are not a missing standardized message cursor.

`$/cancel_request` permits, but does not require, the receiver to abort the
underlying operation. A normal response remains conformant. Semantic Run
cancellation is carried by `session/cancel` and is mandatory for this service.

## Transport And Boundary Matrix

| ID      | Contract                                                                                                            | Current evidence                                  | State           |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| WIRE-01 | Exact `/v1/acp` HTTP/WebSocket and `/v2/acp` WebSocket routes.                                                      | HTTP server/stream tests                          | Covered         |
| WIRE-02 | Readiness is checked before Agent access resolution.                                                                | HTTP server tests                                 | Covered         |
| WIRE-03 | Missing subject is 401; rejected subject is 403 for both versions.                                                  | HTTP server tests                                 | Covered         |
| WIRE-04 | Malformed JSON returns JSON-RPC `-32700` and the connection survives.                                               | raw-wire test                                     | Covered         |
| WIRE-05 | Binary messages close with WebSocket code 1003                                                                      | v1 and v2 raw-wire tests in `http-server.test.ts` | Layer-covered   |
| WIRE-06 | Payloads beyond the configured maximum close with code 1009                                                         | v1 and v2 raw-wire tests in `http-server.test.ts` | Layer-covered   |
| WIRE-07 | Shutdown terminates open transports deterministically.                                                              | HTTP server test                                  | Covered         |
| HTTP-01 | Official HTTP client initialize/new/list/load; bound POST/GET/DELETE, payload limits.                               | `http-stream.test.ts`                             | Covered         |
| HTTP-02 | Foreign/revised binding rejection, DELETE cleanup, capacity and idle expiry with active SSE preserved.              | `http-stream.test.ts`                             | Covered         |
| HTTP-03 | PostgreSQL Prompt/Tool/cancel/load, active Run reconnect, HTTP-to-WebSocket recovery and foreign Session isolation. | `acp-http.postgres.test.ts`                       | Service-covered |
| WIRE-08 | JSON-RPC IDs are preserved and unknown methods return `-32601`.                                                     | both version raw-wire tests                       | Covered         |
| WIRE-09 | v2 initialize is the only item in its batch.                                                                        | raw-wire batch rejection test                     | Covered         |
| WIRE-10 | ACP `_meta` trace context reaches application/model/MCP spans.                                                      | telemetry unit tests                              | Layer-covered   |

## Unadvertised Surfaces

The exclusion list below is an explicit architecture and stability decision,
not merely the absence of a capability flag. Permissions are implemented
reverse requests and do not require an invented initialize capability.

- Gateway authentication replaces v1 `authenticate/logout` and v2
  `auth/login`/`auth/logout`; Provider management is owned by Agent Controller.
- Runtime-owned files and execution replace v1 client filesystem and terminal
  delegation. v2 has no equivalent delegation method set.
- All client MCP injection and its tunnel are deferred together. The v1 stdio
  baseline incompatibility remains an intentional deviation.
- Stable form/URL elicitation is deferred until the official Runtime MCP SDK
  supports it; see [elicitation](../../../runtimes/antnest-runtime/docs/elicitation.md).
- Draft Provider management, NES/document synchronization and the recorded
  draft content and plan extensions are deferred. v2 agent-owned
  `terminal_update`/`terminal_output_chunk` are unimplemented draft forms, not
  client-terminal delegation. Revisit them when the protocol stabilizes.
- Complete user messages and replacement Tool content do not need to use every
  alternative chunk representation. Configuration contains real model and mode
  select options, with no invented boolean or legacy model selector.

`OPTIONAL-NEGATIVE-01` proves that `providers/list` and an unknown custom
request return `-32601` on both raw-wire versions. Additional optional request
negatives exist in v1 only, so this is not exhaustive per-version evidence, and
notifications are not described as requests returning errors. Remaining test
combinations include method- and direction-specific unsupported messages,
including pre-initialize notifications. Lower-layer or sibling-version coverage
is not a substitute for these combinations.

## Summary

- Stable v1 is the primary line; the supported Session surface has adapter and
  real WebSocket/PostgreSQL evidence. Draft v2 is a separate adapter.
- All client MCP injection is deferred and no corresponding optional capability
  is advertised. Future administrator authorization applies to client injection
  as a whole, as defined in the [trust policy](client-mcp-policy.md). The
  mandatory v1 stdio deviation is explicit.
- Gateway isolation, restart recovery and trace checks are valid within their
  named test scenarios, not as universal guarantees. Cross-service behavior is
  covered by the E2E suites under [`tests/e2e`](../../../tests/README.md).
- This is Antnest's restricted ACP profile, not a claim of full generic ACP
  conformance.
