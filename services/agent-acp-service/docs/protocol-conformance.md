# ACP Protocol Conformance

## Purpose

This document defines ACP tests from the protocol inward. It must not infer
conformance from the methods that happen to exist in the implementation.

The pinned implementation schema is `@agentclientprotocol/sdk` `1.4.0`:

- package root and `schema/schema.json`: ACP v1, including experimental surfaces;
- `experimental/v2` and `schema/v2/schema.unstable.json`: draft ACP v2.

Check stability per capability against the official protocol/RFD status, not
just the SDK export path or the absence of an unstable label on a leaf type.

A protocol surface is conformant only when all baseline requirements and every
advertised optional capability have executable positive evidence. This is a
minimum conformance rule, not the service's product-completeness target.

The approved target is to implement all applicable stable ACP capabilities,
including optional ones. Only documented architecture incompatibilities and
features awaiting protocol stability may be excluded or deferred. Clients
select the capabilities they use; a missing UI or a current client's narrower
workflow must not remove capabilities from the server backlog. See the
[current scope decision and backlog](protocol-gap-review.md#5-服务端完整性目标与补齐清单).

The [completion and Goose reuse plan](protocol-completion-plan.md) records ten
confirmed completion areas. Non-architectural behavior follows Goose where
applicable. Sessions may select available organization models and override
Agent-default authorization behavior without rewriting Agent defaults. These
scope decisions are settled; multi-user isolation, Controller authority and
durable Run semantics remain unchanged. The plan also records the verified stable
form/URL elicitation surface and draft-only exclusions. This documentation
update does not mark missing features implemented or validated.

Unimplemented capabilities must remain unadvertised and explicitly rejected.
Negative tests prove that boundary, not completion of the missing capability.
Every exception records the specific surface, reason, source and revisit
condition. An unverified stability status remains pending review, not an
automatic deferral. Existing draft implementations retain their regression
obligations. Goose-private APIs are reference behavior, not standard ACP scope.

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

Passing SDK serialization is necessary but insufficient. The matrix separately
tests capability honesty, handler semantics, wire framing, authorization,
durability, and recovery.

The [interface and Goose gap review](protocol-gap-review.md) found seven
baseline semantic defects outside client MCP injection. The repair batch below
adds targeted evidence rather than treating the older passing interface cases
as proof that all content and lifecycle combinations work. Do not promote
case-level coverage labels into a blanket protocol-completeness claim.

## Model Streaming Batch F01 (2026-09-08)

| Contract                                                                                                                                                                 | Executable evidence                                                              | Coverage        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------- |
| Decode actual SSE across UTF-8/network boundaries; accumulate text/thought, indexed Tool arguments and final usage; reject truncated or malformed completion             | `openai-stream.test.ts`, existing `openai-compatible.test.ts`                    | Layer-covered   |
| Await output persistence; coalesce by time/size, flush accepted tail on cancellation, propagate persistence failure, close timers                                        | `model-output.test.ts`, `turn-runner.test.ts`                                    | Layer-covered   |
| Text/thought reaches the v1 wire before Provider completion; reconnect/load preserves output without duplicates                                                          | `acp-streaming.postgres.test.ts`                                                 | Service-covered |
| Stable message identity for each response, distinct thought identity, real v2 chunk notifications rather than replacement message upserts, replay reconstructs full text | `acp-streaming.postgres.test.ts`                                                 | Service-covered |
| Durable chunks rebuild one assistant context item or one complete Tool exchange, with its compaction sequence boundary                                                   | `acp-streaming.postgres.test.ts`                                                 | Service-covered |
| Cancellation/failure retains partial output and does not execute unfinished Tool arguments                                                                               | `openai-stream.test.ts`, `turn-runner.test.ts`, `acp-streaming.postgres.test.ts` | Service-covered |

Final service acceptance: 268 unit/component cases in 36 files and all 72
PostgreSQL cases in ten files passed. Production build, root `make fmt-check`
and `make lint` passed. Verification ran serially against a dedicated test
database. These are the historical F01 batch totals; F02 evidence follows below.

The tests use the real model SSE adapter, ACP SDK/transports and owned
PostgreSQL persistence with deterministic Provider streams and dependency
ports. This is not a new external Provider, browser, Gateway/Runtime or Jaeger
deployment acceptance result. Internal response grouping uses existing JSON
event storage; no new table, migration or private ACP field was added.

## Tool Progress Consumer Batch F02 (2026-09-08)

| Contract                                                                                                                          | Executable evidence                           | Coverage        |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------- |
| First preview before final HTTP MCP result; official SDK token association and execution fence                                    | `test/adapters/mcp/tool-progress.test.ts`     | Layer-covered   |
| Bounded UTF-8 preview, coalescing, slow persistence, numeric units, silent tools, event limits, late callbacks and write failures | `test/application/tool-progress.test.ts`      | Layer-covered   |
| Same normalized Tool ID, previews before success/failure/cancellation, failed writes abort IO without retry                       | `test/application/turn-runner.test.ts`        | Layer-covered   |
| Real HTTP MCP -> Tool loop -> PostgreSQL -> ACP v1/v2 live updates, replay and identity isolation                                 | `test/e2e/acp-tool-progress.postgres.test.ts` | Service-covered |
| Terminal Tool/Run reject new progress; live and rebuilt model context contain final results, not previews                         | `test/e2e/acp-tool-progress.postgres.test.ts` | Service-covered |

Additional regression evidence covers blocked progress writes during cancellation,
failure or ownership loss (`turn-runner.test.ts`), delayed invalidation after a
terminal Tool (`session-output.test.ts`) and competing progress/finish transactions
under the PostgreSQL Session lock (`acp-tool-progress.postgres.test.ts`).

These service tests use an official SDK MCP fixture and deterministic model/controller
ports, not a Rust Runtime container or external Provider. Gateway + deployed Runtime
integration remains a separate batch. F03-F10 are not covered by this change.
See [consumer contract](tool-progress.md) for preview budgets and lifecycle semantics.

Final service acceptance: 282 unit/component cases in 38 files and 78 PostgreSQL
cases in 11 files passed. Production build, root `make fmt-check` and `make lint`
passed. The coordinator completed verification and cleaned the dedicated test
database; one read-only reviewer was closed after reporting, with regression
tests added for its identified coverage gaps. No new table or migration was needed.

## Tool Progress Deployment Batch F02 (2026-09-08)

F02 deployment evidence is now separately complete: [reusable profile](../../../scripts/acp-progress/README.md).
Twelve cases cover Gateway ACP v1/v2, real Rust Bash / managed stdio MCP,
early progress, success/error/cancellation and fresh-connection replay. Twenty
deterministic SSE model requests validate actual results and reject preview
pollution. Twelve Jaeger traces establish Gateway ancestry, per-Run preparation,
and exactly one ACP dispatch / Runtime tool invocation each. Cancellation checks
actual execution termination separately from unresolved effect classification
and blocked subsequent admission. The disposable project's containers, volumes
and networks were removed; no external Provider or browser test was used.

## Tool Presentation Foundation F03 (2026-09-08)

| Behavior                                                                                                                                            | Executable evidence                                                                                            | Coverage        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| Exact builtin kind, deterministic/MCP title, real workspace target, unknown/ambiguous location omission                                             | `test/domain/tool-presentation.test.ts`, `test/adapters/mcp/tool-presentation.test.ts`, `tool-catalog.test.ts` | Layer-covered   |
| Independent bounded structured output; Unicode JSON shape survives adapter storage                                                                  | `test/adapters/postgres/session-event-codec.test.ts`, `test/domain/tool-presentation.test.ts`                  | Layer-covered   |
| v1/v2 live, reconnect, fork and identity isolation; declared error versus unknown outcome; previews do not override metadata or enter model context | `test/e2e/acp-tool-presentation.postgres.test.ts`                                                              | Service-covered |
| NUL keys/values and lone surrogates survive live and persisted replay/fork without blocking Run completion                                          | `test/e2e/acp-tool-presentation.postgres.test.ts`, `test/adapters/postgres/repositories.postgres.test.ts`      | Service-covered |
| Recovery updates status/content without replacing initial title or inventing raw output                                                             | `test/adapters/postgres/repositories.postgres.test.ts`                                                         | Service-covered |

Final service acceptance: 317 unit/component cases (41 files), 85 PostgreSQL
cases (12 files), production build and root formatting/lint gates passed.
Read-only review findings are repaired and covered; reviewers closed. No new
table, RPC or extra Tool execution was introduced. File observations were not
part of that foundation batch; their subsequent consumer coverage is below.
Actual F03 Gateway/Runtime deployment evidence is recorded in its separate batch below.

## Runtime File Fact Consumer F03 (2026-09-09)

| Behavior                                                                                                                                                                                    | Executable evidence                                                                                    | Coverage                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| Exact builtin identity and settled success; invalid paths/metadata, conflicting fields and encoded size rejected; read and omitted diff remain location-only                                | `test/adapters/mcp/file-observation.test.ts`, `tool-presentation.test.ts`                              | Layer/component-covered   |
| Actual MCP metadata reaches the adapter without entering model output; error result cannot claim a successful file change                                                                   | `test/adapters/mcp/tool-presentation.test.ts`, `test/e2e/acp-tool-presentation.postgres.test.ts`       | Component/service-covered |
| v1 complete before/after; v2 add/modify and optional absolute Git patch; null versus empty, Unicode/NUL, CRLF, no final newline, quoting, path fidelity and bounded work/output             | `test/transport/file-content.test.ts`                                                                  | Layer-covered             |
| Escaped file facts survive PostgreSQL; actual path replaces intent; v1/v2 SDK-schema-valid live, replay, fork, application recreation, identity isolation; exactly one actual SDK Tool call | `test/e2e/acp-file-observation.postgres.test.ts`, `test/adapters/postgres/session-event-codec.test.ts` | Service-covered           |
| Complete file facts absent from model requests, loaded context and stored Tool summaries                                                                                                    | `test/e2e/acp-file-observation.postgres.test.ts`                                                       | Service-covered           |
| Tool instrumentation preserves caller result without adding file paths/content to telemetry                                                                                                 | `test/telemetry/instrumented-ports.test.ts`                                                            | Layer-covered             |

The tests use real official MCP HTTP SDK, ACP wire connections and PostgreSQL,
with deterministic Controller/model fixtures. They do not themselves verify real
Rust Runtime or Gateway/Jaeger integration; that separate batch is below.
No new external Provider or browser claim is made.

Final service acceptance: 358 unit/component cases (43 files), 95 PostgreSQL
cases (13 files), production build, root `make fmt-check` and `make lint` passed.
The independent read-only review's path-fidelity finding has regression coverage;
the reviewer is closed. No new table, Tool execution or model-context copy was
introduced for file observations.

## Tool Presentation Deployment F03 (2026-09-09)

[The deployed profile](../../../scripts/acp-files/README.md) validates login,
Gateway/Console Agent management, actual Runtime read/write/edit, v1/v2 standard
Tool output, new-connection replay and fork. Sixteen cases pass, with 32 validated
deterministic model requests. Creation/empty-before/full-file edit/read/no-change/
oversized/error outputs and Unicode/parent-whitespace paths are checked against
the actual execution. Official schemas validate Tool updates; parsed v2 patches
must reproduce both the exact path and content.

Jaeger covers 16 execution traces plus 16 independent replay/fork traces. Each
execution has one Runtime information read/catalog read, one ACP dispatch and
one actual Runtime Tool descendant; replay/fork has neither model nor Runtime
execution. Two foreign-user upgrades are rejected. Short content sentinels and
synthetic credentials are absent from traces; edit-only file context does not
enter any model message role. The disposable project was removed in full.
Fixture-negative tests detect wrong Tool ancestry, missing replay traces,
accidental replay execution, missing/fragmentary/false diffs and snippet leaks.
These results complete F03's defined workflow, not F04-F10 or unrestricted ACP.

## Structured Plan Service Batch F04 (2026-09-09)

The [structured-plan contract](structured-plan.md) uses a local `update_plan`
tool and complete plan replacement, not Markdown inference or a Runtime tool.
The same committed fact becomes v1 `plan` or v2 items `plan_update`.

| Behavior                                                                                                                                                                    | Executable evidence                                                                        | Coverage                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| Full entries, explicit clear, schema bounds and name collision; local dispatch without Runtime execution or remote ToolAttempt                                              | `test/domain/plan.test.ts`, `test/application/plan-execution.test.ts`                      | Layer/component-covered  |
| SDK-valid v1/v2 notifications before final reply; load/resume, fork, application recreation and cross-user/Agent isolation                                                  | `test/e2e/acp-plan.postgres.test.ts`                                                       | Service-covered          |
| Atomic plan/result rollback, cancellation ordered by actual Run lock, duplicate commit rejection and publication failure after commit                                       | `test/e2e/acp-plan.postgres.test.ts`                                                       | PostgreSQL-covered       |
| Latest plan independent of checkpoint; real budget-driven compaction retains an assistant-authored Run-start snapshot, with later updates taking precedence                 | `test/application/plan-context.test.ts`, `test/e2e/acp-plan.postgres.test.ts`              | Layer/service-covered    |
| NUL and lone surrogates survive all persisted argument copies, replay and context; interrupted-call recovery before/after local commit does not invent a remote side effect | `test/adapters/postgres/session-event-codec.test.ts`, `test/e2e/acp-plan.postgres.test.ts` | Layer/PostgreSQL-covered |

The suite uses real ACP wire connections and PostgreSQL with deterministic
model, Controller and Runtime fixtures. Application recreation and interrupted
call recovery tests are not an OS-process kill E2E. Gateway/UI/Jaeger deployment
acceptance belongs to the separate F04 batch below; prior F03 traces do not establish it.
Both independent read-only reviewers are closed. The implementation review's
JSONB-string and stale-plan-context findings have failing-then-passing tests.

Final service acceptance: 377 unit/component cases (46 files), 106 PostgreSQL
cases (14 files, including 11 F04 cases), production build, root `make fmt-check`
and `make lint` passed. The batch-owned database and role were removed; existing
acceptance instances were preserved. No external Provider was called.

## Structured Plan Deployment F04 (2026-09-09)

The [deployment profile](../../../scripts/acp-plan/README.md) passed twelve
Gateway v1/v2 scenarios and 22 deterministic model requests. It verifies exact
initial/replacement/clear plans before a gated final reply, rejected invalid
updates, cross-Run empty-state recovery, preserved pre-clear fork state and
new-connection replay. Tool IDs cannot be reused by a later Run in the same
Session; model inputs preserve ordered, matched calls/results. Official SDK
schemas validate live and replay events. Two foreign-user upgrades and four
cross-Agent Session methods return explicit access denials without private data.

Four execution traces cover twelve Runs with per-admission preparation,
Controller lifecycle, model and PostgreSQL ancestry from Gateway. Only two Runs
dispatch a remote write, each with exactly one actual Runtime Tool descendant;
local plan mutations do not count as remote execution. Eight independently
collected replay/denial traces contain lifecycle operations but no model or
Runtime execution. Content/credential sentinels are absent from these Jaeger
traces; no claim covers all stdout logs, metrics or browser UI. Two read-only
reviewers are closed. The final full rerun passed after fixture corrections;
all batch-owned containers, volumes and networks were removed.

Final gates: 701 Node tests passed, including 11 F04 acceptance-oracle fixtures;
root format/lint checks passed without relaxed gates. The production ACP image
built successfully. Runtime production build passed Linux tests (126 module +
one non-root CLI case), Clippy and release compilation. This closes the defined
F04 service/deployment boundary, not F05-F10 or unrestricted ACP completeness.

## Semantic Defect Repair Batch (2026-09-08)

| ID  | Repaired behavior                                                                                                                                              | Executable evidence                                                                           | Coverage        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------- |
| D1  | Full v1 content precedes completion/cancellation response under backpressure; durable execution does not await delivery                                        | `acp-v1-agent.test.ts`, `session-output.test.ts`, `acp-output.postgres.test.ts`               | Service-covered |
| D2  | Tool images survive the next model request; all Tool replies precede image messages; non-vision omission and local errors are explicit                         | `openai-compatible.test.ts`                                                                   | Layer-covered   |
| D3  | Active Run output follows a replacement v1 load/resume or v2 resume connection; catch-up cursor and state share one snapshot; idle waits for admission closure | `session-output.test.ts`, `acp-output.postgres.test.ts`, `acp-access.postgres.test.ts`        | Service-covered |
| D4  | UTF-8 text blobs become readable text in retained/model context; unhandled binary input fails before Run admission                                             | `embedded-resource.test.ts`, `prompt-coordinator.test.ts`, `acp-output.postgres.test.ts`      | Service-covered |
| D5  | Reused provider Tool IDs are unique across requests/Runs, paired in model history and stable in replay/fork                                                    | `turn-runner.test.ts`, `acp-output.postgres.test.ts`                                          | Service-covered |
| D6  | Cancellation during usage/thought/final-message persistence cannot produce completed; final-message boundary matches wire, stored Run and Controller outcome   | `turn-runner.test.ts`, `acp-output.postgres.test.ts`                                          | Service-covered |
| D7  | Unmatched absolute cwd returns an empty list; relative/invalid filters are rejected independently from workspace creation                                      | `session-service.test.ts`, `acp-output.postgres.test.ts`, existing lifecycle pagination tests | Service-covered |

These tests use real SDK/transport and service-owned PostgreSQL where indicated,
with deterministic model/Controller/Tool ports. They do not establish a new
Gateway -> Runtime -> external model acceptance result. No new ACP fields,
client MCP injection, streaming model API, PDF parser or authentication mode is
introduced by this batch. Owned tables and schema are unchanged.

Final service acceptance: 245 unit/component cases in 33 files, all 61
PostgreSQL cases in eight files, production build, `make fmt-check` and
`make lint` passed. The disposable PostgreSQL container, volume and networks
were removed. Architecture/optional-scope decisions in the gap review remain
pending; full-platform acceptance was not repeated for this batch.

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
| `crates/goose/src/acp/transport/mod.rs::create_acp_router_inner`   | `serve` uses the official HTTP server; Antnest now uses the official TypeScript HTTP server on `/v1/acp`, retaining WebSocket for both versions            |
| `crates/goose/src/acp/server_factory.rs::AcpServer`                | Connection state and shared active Runs have different lifetimes; Antnest persists Sessions/Runs and keeps connection identity separate                    |
| `crates/goose/src/acp/server.rs::mcp_server_to_extension_config`   | Goose launches client stdio locally; Antnest must not copy that onto its shared ACP host. Runtime-managed stdio is a separate source                       |
| `crates/goose/src/acp/server/dispatch.rs`                          | Baseline requests, negotiated client callbacks and `_goose/*` extensions are distinct; private Provider/recipe/steer/scheduler APIs are not v1 obligations |

WebSocket is a documented custom v1 transport, which v1 permits; it is not
evidence of implementing the draft Streamable HTTP transport. ACP transport
stdio and client-supplied **MCP** stdio are two different questions.

## Stable ACP v1 Matrix

| ID              | Protocol contract                                                                                                                            | Current evidence                                                                                                                    | State                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| V1-INIT-01      | `initialize` returns supported v1 for requested 0/1/2/99; truthful capabilities                                                              | `acp-v1-agent.test.ts`                                                                                                              | Covered                   |
| V1-INIT-02      | All ten supported Session requests reject before initialize; initialize only once                                                            | `acp-v1-agent.test.ts`                                                                                                              | Covered                   |
| V1-NEW-01       | `session/new` creates an owned Session with workspace and empty MCP revision                                                                 | `acp-v1-lifecycle.postgres.test.ts`, `acp-mcp-input.postgres.test.ts`                                                               | Service-covered           |
| V1-LOAD-01      | `session/load` replays ordered durable user/usage/Tool/assistant updates before response                                                     | `acp-v1-lifecycle.postgres.test.ts`, `acp-happy-path.postgres.test.ts`                                                              | Service-covered           |
| V1-LIST-01      | `session/list` scopes ownership and paginates 52 Sessions without duplicates                                                                 | `acp-v1-lifecycle.postgres.test.ts`                                                                                                 | Service-covered           |
| V1-DELETE-01    | `session/delete` is idempotent for missing/deleted records, hides from list, retains history and ownership checks                            | `session-service.test.ts`, `acp-v1-lifecycle.postgres.test.ts`                                                                      | Service-covered           |
| V1-FORK-01      | Advertised draft `session/fork` copies context with new identities, no Run execution, independent subsequent history                         | `acp-v1-lifecycle.postgres.test.ts`                                                                                                 | Service-covered           |
| V1-RESUME-01    | `session/resume` reactivates without historical replay and accepts a new Prompt                                                              | `acp-v1-lifecycle.postgres.test.ts`                                                                                                 | Service-covered           |
| V1-CLOSE-01     | `session/close` retains list/history, rejects Prompt until load/resume                                                                       | `acp-v1-lifecycle.postgres.test.ts`                                                                                                 | Service-covered           |
| V1-PROMPT-01    | Prompt blocks until terminal Run outcome and returns its stable stop reason                                                                  | adapter terminal tests + `acp-v1-lifecycle.postgres.test.ts`                                                                        | Service-covered           |
| V1-CONTENT-01   | Text, links and native image/audio/PDF follow actual model capabilities; unsupported input rejects without execution                         | `acp-v1-agent.test.ts`, `acp-multimodal.postgres.test.ts`; F09 deployment                                                           | Service-covered           |
| V1-CANCEL-01    | Notification settles running Prompt as cancelled; next Prompt succeeds                                                                       | `acp-v1-lifecycle.postgres.test.ts`                                                                                                 | Service-covered           |
| V1-UPDATE-01    | Message/thought/Tool/usage map in order; persisted transcript replays faithfully                                                             | adapter update tests + `acp-v1-lifecycle.postgres.test.ts`                                                                          | Service-covered           |
| V1-STREAM-01    | Stable message/thought IDs and chunks precede completion; progress and actual file facts replay without another Tool call                    | `acp-streaming.postgres.test.ts`, `acp-tool-progress.postgres.test.ts`, `acp-file-observation.postgres.test.ts`; F02/F03 deployment | Service-covered           |
| V1-CONFIG-01    | `session/set_config_option` and `session/set_mode` persist real model/mode choices, broadcast full configuration and apply at next admission | `acp-configuration.postgres.test.ts`; F05/F06 deployment                                                                            | Service-covered           |
| V1-PERMIT-01    | Agent-to-client `session/request_permission` controls actual dispatch for once/session allow/deny and cancellation                           | `acp-permissions.postgres.test.ts`; F06 deployment                                                                                  | Service-covered           |
| V1-PLAN-01      | Standard full-list `plan` replaces, clears, replays and forks the saved plan                                                                 | `acp-plan.postgres.test.ts`; F04 deployment                                                                                         | Service-covered           |
| V1-COMMAND-01   | Setup emits `available_commands_update`; `/help` and `/帮助` run through ordinary Prompt without model/Runtime calls                         | `acp-commands.postgres.test.ts`; F08 deployment                                                                                     | Service-covered           |
| V1-COST-01      | Standard `usage_update.cost` carries saved cumulative known amounts, excluding private receipts                                              | `acp-cost.postgres.test.ts`; F10 deployment                                                                                         | Service-covered           |
| V1-INFO-01      | `session_info_update` maps title/updatedAt; full live/observer/reload consistency combination remains unverified                             | `acp-v1-agent.test.ts`, list persistence tests                                                                                      | Layer-covered             |
| V1-ERROR-01     | Invalid initialization/params, failed/unresolved Runs and unknown methods retain distinct errors                                             | adapter + raw-wire + lifecycle tests                                                                                                | Covered                   |
| V1-MCP-01       | Nonempty HTTP/stdio/SSE/MCP-over-ACP input is rejected at every setup method, with no partial writes or replay                               | `acp-mcp-input.postgres.test.ts`                                                                                                    | Service-covered           |
| V1-MCP-STDIO-01 | Generic v1 Agents must support client stdio MCP                                                                                              | Explicit platform-only profile above                                                                                                | **Intentional deviation** |

This is a restricted v1 Session service, not a generic fully conformant Agent.
Platform-managed stdio children are reached through Runtime; they do not
implement the client-supplied stdio field. No client-side MCP proxy is planned
under this product boundary. See [Runtime context](runtime-context.md).

`session/delete` follows v1's SHOULD-level idempotency guidance. An existing
foreign Session still fails ownership checks, even after deletion. Retention
does not grant access, and idempotency does not mean ignoring arbitrary errors.

`session/update` is the Agent-to-client callback. Runtime-owned execution is the
approved alternative to delegation to client filesystem/terminal resources.
Permission and elicitation are separate human-interaction paths: Runtime
execution does not replace them. Permission is implemented in F06; stable
elicitation remains explicitly deferred while the official Runtime MCP SDK lacks
the required URL support. Session configuration is implemented in F05 below.
Split draft/private surfaces from stable ones individually;
do not exclude Provider/mode/editor/NES as one group.

## Draft ACP v2 Matrix

| ID            | Protocol contract                                                                                                                            | Current evidence                                                                                    | State           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------- |
| V2-INIT-01    | Official SDK rejects all eight registered Session requests before initialize without application calls; initialize-once and capability shape | `http-server.test.ts`, `acp-agent.test.ts`                                                          | Layer-covered   |
| V2-NEW-01     | `session/new` creates an owned workspace Session with empty client MCP; nonempty lists reject                                                | `acp-mcp-input.postgres.test.ts`                                                                    | Service-covered |
| V2-LIST-01    | `session/list` paginates 52 owned Sessions with metadata, no duplicate/missing/foreign entries                                               | dual-version `acp-v1-lifecycle.postgres.test.ts`                                                    | Service-covered |
| V2-RESUME-01  | Baseline `session/resume` supports no replay cursor and `start`.                                                                             | replay tests                                                                                        | Covered         |
| V2-RESUME-02  | Unknown extension replay cursors are rejected rather than guessed.                                                                           | unknown-cursor test                                                                                 | Covered         |
| V2-CLOSE-01   | Baseline `session/close` reaches the authorized application operation.                                                                       | lifecycle mapping test                                                                              | Covered         |
| V2-DELETE-01  | Advertised `session/delete` retains ownership checks and idempotent deletion                                                                 | dual-version `acp-v1-lifecycle.postgres.test.ts` cases                                              | Service-covered |
| V2-FORK-01    | Advertised `session/fork` copies context/configuration with independent later history                                                        | `acp-mcp-input.postgres.test.ts`, F04/F05/F09/F10 persistence/deployment                            | Service-covered |
| V2-PROMPT-01  | Prompt response ACK precedes every update on both memory and WebSocket transports.                                                           | adapter and raw-wire ordering tests                                                                 | Covered         |
| V2-CONTENT-01 | Text, links and native image/audio/PDF use the actual configured model; unsupported input rejects                                            | `acp-multimodal.postgres.test.ts`; F09 deployment                                                   | Service-covered |
| V2-CANCEL-01  | Semantic `session/cancel` settles execution before terminal idle.                                                                            | same- and replacement-connection tests                                                              | Covered         |
| V2-UPDATE-01  | User/agent/thought messages, streamed chunks, Tool updates, usage and state retain version-specific ordering                                 | `acp-happy-path.postgres.test.ts`, `acp-streaming.postgres.test.ts`, F02/F03 persistence/deployment | Service-covered |
| V2-CONFIG-01  | `session/set_config_option` persists/broadcasts model and mode select, with restore and next-admission effect                                | `acp-configuration.postgres.test.ts`; F05/F06 deployment                                            | Service-covered |
| V2-PERMIT-01  | Reverse `session/request_permission` responses control real Tool dispatch and cancellation                                                   | `acp-permissions.postgres.test.ts`; F06 deployment                                                  | Service-covered |
| V2-PLAN-01    | `plan_update` with current plan identity replaces/clears complete entries and survives replay/fork                                           | `acp-plan.postgres.test.ts`; F04 deployment                                                         | Service-covered |
| V2-COMMAND-01 | Setup command catalog and ordinary Prompt execution use official shapes                                                                      | `acp-commands.postgres.test.ts`; F08 deployment                                                     | Service-covered |
| V2-COST-01    | Reported/estimated known cost persists and replays without private receipts or double counting                                               | `acp-cost.postgres.test.ts`; F10 deployment                                                         | Service-covered |
| V2-INFO-01    | Session metadata mapping/live delivery; observer/reload consistency combination remains unverified                                           | `acp-agent.test.ts`, `acp-happy-path.postgres.test.ts`                                              | Layer-covered   |
| V2-MCP-01     | No client MCP capability advertised; nonempty inputs reject across new/resume/fork                                                           | adapter + PostgreSQL MCP input tests                                                                | Service-covered |
| V2-BATCH-01   | WireStream accepts valid batches and preserves per-entry JSON-RPC responses.                                                                 | mixed request/notification raw-wire test                                                            | Covered         |

The only standardized v2 replay cursor in SDK `1.4.0` is `start`. Other values
are extension cursors whose documented safe behavior is preservation or
rejection. They must not be treated as a missing standardized message cursor.

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

## Unadvertised Surfaces And Completion Backlog

The exclusion ledger is the approved architecture/stability section in the
[completion plan](protocol-completion-plan.md#4-已确认架构边界) and its
[stability ledger](protocol-completion-plan.md#5-等待协议稳定), not the
absence of a capability flag. Permissions are implemented reverse requests and
do not require an invented initialize capability. Current exclusions are:

- Gateway authentication instead of v1 `authenticate/logout` or v2
  `auth/login`/`auth/logout`; Controller-owned Provider management.
- Runtime-owned files and execution instead of v1 client filesystem/terminal
  delegation. v2 has no equivalent v1 delegation method set.
- All client MCP injection and its tunnel are deferred together. The v1 stdio
  baseline incompatibility remains an intentional deviation.
- F07 stable form/URL elicitation is deferred by the explicit official-SDK
  decision, not mislabeled as an unstable ACP capability.
- Draft Provider management, NES/document synchronization and the specifically
  recorded draft content/plan extensions remain deferred. v2 agent-owned
  `terminal_update`/`terminal_output_chunk` are also unimplemented draft forms;
  they are not client-terminal delegation. Revisit them on protocol stabilization.
- Existing complete user messages and replacement Tool content do not need to
  use every alternative chunk representation. Current configuration contains
  real model/mode select options, no invented boolean or legacy model selector.

`OPTIONAL-NEGATIVE-01` currently proves `providers/list` and an unknown custom
request return `-32601` on both raw-wire versions. Additional optional request
negatives are present in v1 only. That is not exhaustive per-version evidence,
and notifications must not be described as requests returning errors.
Remaining test combinations are tracked explicitly: method/direction-specific
unsupported messages (including pre-initialize notifications), protocol-level
`$/cancel_request`, and cross-connection/restored Session metadata consistency.
Existing lower-layer or sibling-version coverage is not a substitute for these
combinations. None is grounds for silently weakening the product target.

The C1 test reconciliation on 2026-09-10 closes version-symmetric binary/payload
wire checks, v2 initialize-before-use for every registered Session request,
and v2 PostgreSQL pagination. All 538 unit/component tests (59 files) and all
160 PostgreSQL tests (21 files) passed. Request rejection proves that no
application method was entered; paging excludes another owner and returns
every owned Session exactly once. The dedicated test database/container/volume
were removed. Notification direction, request cancellation and metadata
observer/reload combinations remain a subsequent batch. This is not a claim
that all of C1 or the final Docker/browser acceptance is complete.

The corresponding fresh Docker recovery regression also passed on 2026-09-10:
both versions completed three real SIGKILL/restart scenarios (six total), with
20 controlled model requests, unchanged replay and no repeated Bash effects.
Two baseline Gateway-rooted traces contained 462 spans across Identity,
Controller, ACP and Runtime. Seventy-seven affected fixture/oracle tests,
`make -j1 fmt-check lint`, shell syntax and changed documentation link checks
passed. The [C1 closeout assessment](../../../docs/docker-single-node-closeout.md#c1-recovery-and-matrix-reconciliation)
records scope. The subsequent [active-Run rebuild batch](../../../docs/docker-single-node-closeout.md#c1-active-run-rebuild-2026-09-10)
adds stable-v1 deployed revision/Run-boundary evidence; uncertain effects remain open.

## Session Configuration Consumer F05 (2026-09-09)

| Requirement                                                                                                     | Reusable evidence                                                                                                                 | Boundary                                            |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Model/mode setup, v1 mode alias, full responses and cross-version notifications; official SDK schema validation | `test/e2e/acp-configuration.postgres.test.ts`                                                                                     | Real ACP v1/v2 and PostgreSQL                       |
| Live identity checks, foreign Session rejection, invalid choice, CAS conflict and event atomicity               | `test/application/session-configuration.test.ts`, `test/e2e/acp-configuration.postgres.test.ts`                                   | Service-owned                                       |
| Reconnect/load/resume/fork preserve overrides; config events stay out of model history                          | `test/e2e/acp-configuration.postgres.test.ts`                                                                                     | Service-owned                                       |
| Active snapshot unchanged; next Run changes model endpoint/credential/context; Chat exposes no tools            | `test/e2e/acp-configuration.postgres.test.ts`, `test/application/configuration-execution.test.ts`                                 | Deterministic Controller/model/Tool ports           |
| Admission intent and recovery retain the original selection; missing new-admission configuration fails closed   | `test/application/run-recovery.test.ts`, `test/adapters/controller/client.test.ts`, `test/e2e/acp-configuration.postgres.test.ts` | No implicit auto authorization                      |
| Exact-source authorization rules; inherited default and unavailable model presentation                          | `test/domain/session-configuration.test.ts`, `test/application/configuration-execution.test.ts`                                   | User permission interaction remains F06             |
| Output cursor preservation and pending own-message filtering; operation spans exclude selections                | `test/transport/session-output.test.ts`, `test/telemetry/instrumented-ports.test.ts`                                              | Component tests, not a new Jaeger deployment report |

Only model/mode select options are currently advertised. There is no real boolean
setting, so no placeholder is invented to exercise boolean capability negotiation.
v1 uses `id` and legacy `modes`; v2 uses `configId`. Neither adds `session/set_model`.
See [Session configuration](session-configuration.md). Cross-service Gateway,
Runtime and Jaeger validation is the following batch; permissions/SmartApprove
risk assessment remain F06, not proven by configuration protocol coverage.

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

| ID              | Scenario                                                                        | State                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E2E-V1-01       | v1 WebSocket + PostgreSQL Prompt, Tool updates, stop reason, reconnect/load.    | Covered                                                                                                                  |
| E2E-V2-01       | v2 WebSocket + PostgreSQL happy path.                                           | Covered                                                                                                                  |
| E2E-AUTH-01     | Cross-principal and cross-Agent Session access never leaks or mutates.          | Covered                                                                                                                  |
| E2E-IDENTITY-01 | Owner deactivation rejects work on an existing Gateway connection.              | Covered                                                                                                                  |
| E2E-STALE-01    | Access revision changes invalidate an existing connection before work.          | v1/v2 rebuild deployed; other combinations service-covered                                                               |
| E2E-RECOVERY-01 | Disconnect/restart/resume replays once without repeating model or Tool effects. | v1/v2 Docker-covered for completed, model-wait, settled, unknown Tool and committed acquire/finish response-loss windows |
| E2E-RUNTIME-01  | Run A retains its captured Runtime; Run B obtains the next revision.            | v1/v2 active-Run rebuild deployed                                                                                        |

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

E2E-RECOVERY-01 now also has v1/v2 deployed uncertain in-flight Tool evidence
from the extension below. AcquireRun/FinishRun response-loss windows now also
have a [dedicated deployed profile](../../../scripts/acp-closeout/rpc-loss.md).
Active-Run rebuild and stale Prompt
rejection now have v1/v2 deployment evidence in the batch linked below.
User deactivation is not proof of browser logout/expiry revocation
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
the newly published Runtime after explicit rebuild. Its 2026-09-10 extension
also holds an active Run at two response boundaries, observes real drain workers,
rejects another Session, and verifies pinned execution through final completion.
After rebuild, a stale Prompt is rejected at Controller admission; reconnect/load
(v1) or resume from start (v2) performs no model or Tool work and the next Run
uses the replacement Runtime. Replay compares one user/Tool/answer timeline and
the terminal Tool identities/results. A successful v2 Run requires `running`
then `idle/end_turn`, not its immediate Prompt acknowledgment. Because this
scenario deliberately leaves a rejected stale Prompt intent in the same
Session, reconnect replays `idle/_failed` without rewriting the earlier
successful history. The new Run still must complete `idle/end_turn`.
v1 live output deliberately omits the initiating user's echo; load must include
each sent input once before that Run's Tool/answer sequence, with a nonempty
unique message ID. This version difference is not handled by discarding user
messages. v2 replay also preserves the user IDs observed during live execution.
Each version passed six Runs, 15 model requests and nine Tool calls. Four
Gateway-rooted execution traces contain 2,022 spans (v1: 1,002; v2: 1,020).
All 161 shared fixture/oracle tests passed, including 31 managed-MCP cases.
Temporary resources were removed before the final result. This is v1/v2 deployed
active-Run rebuild evidence, not unknown-effect recovery, crash-during-rebuild
or browser acceptance. Trace identities and scope are in the
[C1 rebuild report](../../../docs/docker-single-node-closeout.md#c1-active-run-rebuild-2026-09-10).

Unknown-effect extension (2026-09-10): the recovery profile now includes a real
Bash append whose process remains alive at SIGKILL. Both versions preserve an
unresolved Run and exactly one visible failed/unknown Tool update. v2 replay
contains one `idle/_unresolved` state; neither protocol reexecutes the model or
Tool. Another Session remains `agent_busy` until administrator rebuild replaces
the Runtime. Source-container absence is verified by the host before any new
work; Controller release events correlate the original admission and rebuild,
without changing the original terminal report. A subsequent real read proves
the retained append occurred once and the old audit history remains unchanged.

The final fresh Docker run passed eight SIGKILL/restarts and 26 deterministic
model requests. Four completed baseline/recovery Jaeger traces contain 812
spans with Gateway-to-Runtime ancestry. All 150 shared fixture/oracle tests
passed serially. Final success is emitted only after owned resources have been
removed. See the [C1 unknown-effect report](../../../docs/docker-single-node-closeout.md#c1-unknown-effect-recovery-2026-09-10)
and [reproducible profile](../../../scripts/acp-closeout/README.md).
This extension does not claim crash-time unexported spans, RPC response-loss
handling or browser acceptance. The separate managed-MCP profile above supplies
active-Run rebuild parity for draft v2.

Committed-response-loss extension (2026-09-10): `make e2e-rpc-response-loss`
passed v1/v2 AcquireRun and FinishRun cases against real Controller/PostgreSQL,
with four observed ACP self-exits and controlled restarts. Acquire uses the
same durable request/result and its actual saved execution snapshot; Finish
replays the same stored terminal without repeating execution. Two load/resume
replays per case preserve chat and Tool history; current configuration is
returned in setup, not replayed as obsolete changes. A later real Read verifies
one physical append and unchanged Runtime. Eight Runs/eight Tools produced
16 deterministic model requests. Twelve Jaeger traces contain 1,530 spans,
distinguishing Gateway-origin calls from startup retry traces. The profile
exposed and fixed Controller's first-response/replay timestamp precision drift.
See the [C1 RPC report](../../../docs/docker-single-node-closeout.md#c1-rpc-response-loss-2026-09-10)
for scope and final checks; C3-C6 remain open.

## Tool Permission Service Batch F06 (2026-09-09)

This batch changes Agent ACP Service only. It uses the F05 admitted policy and
the official SDK for v1/v2 reverse requests, without a new public approval API.

| Boundary                                                                                                                 | Executable evidence                                                            | Result                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Four permission options, malformed/unknown outcomes, explicit rules and read-only hint precedence                        | `test/domain/tool-permissions.test.ts`                                         | No unrecognized outcome authorizes execution                                                                                           |
| Waiting, once/always, live access revocation, connection replacement, cancellation and worker loss                       | `test/application/tool-permissions.test.ts`                                    | Request stored before interaction; decision committed before dispatch                                                                  |
| SDK cancellation cleanup and v1/v2 envelope differences                                                                  | `test/transport/permission-request.test.ts`                                    | Late replies cannot grant permission; nonresponsive connections are reclaimed                                                          |
| MCP annotation delivery through the official SDK and catalog                                                             | `test/adapters/mcp/official-client.test.ts`, `tool-catalog.test.ts`            | Explicit platform hints reach policy evaluation                                                                                        |
| v1 WebSocket/HTTP and v2 WebSocket with PostgreSQL                                                                       | `test/e2e/acp-permissions.postgres.test.ts`                                    | Four decisions control actual Tool calls; approval precedes all Tool attempts; reconnect, denial, cancellation and deadline paths pass |
| Exact arguments, duplicate answers, atomic rules, locked-transaction deadline/cancellation, startup and terminal cleanup | `test/adapters/postgres/tool-permissions.postgres.test.ts`                     | No stale always rule; terminal Runs cannot regain permission                                                                           |
| Fork and Session lifecycle                                                                                               | Permission E2E plus v1/v2 lifecycle mapping and connection registry unit tests | Parent rules do not escape into a new Session; only successful close/delete detaches                                                   |
| Observability                                                                                                            | Permission application test                                                    | Wait span and bounded decision metrics retain IDs, not Tool arguments                                                                  |

Final test metrics: ACP **427 tests / 53 files**; PostgreSQL **140 tests / 17
files** (123.47 s, serial); repository `make test-node` **751 tests** including
ACP, Console, Agent UI and shared fixtures. The affected ACP tests were rerun
after the final test-adapter corrections. Production TypeScript build passed.
Repository `make fmt-check` and `make lint` passed (Go: zero issues; both Rust
Clippy targets: warnings denied; ACP ESLint and all TypeScript checks passed).

Read-only adversarial review identified and reproduced three defects: using
transaction-start time after a lock wait, copying always rules into Fork, and
retaining closed Session registrations. Regression cases cover their fixes;
independent follow-up review found no remaining blocking finding. Reviewers ran
no tests and were closed after reporting; the coordinator ran verification
serially in a dedicated database, not the acceptance data set. The isolated
database and test role were removed after all PostgreSQL connections closed.

At the end of that service-only batch, remaining F06 work was Goose's LLM read-only judge, followed
by Gateway/Runtime/UI and causal Jaeger deployment acceptance. Smart Approve
currently trusts only explicit rules and non-conflicting platform read-only
hints, asking the user otherwise. No deployment was updated for this batch.
That batch alone was not full F06 or unrestricted ACP conformance.

## F05/F06 Integration Closeout (2026-09-09)

The remaining F06 judge and Agent UI integration are implemented. The judge uses
the admitted model without tools or conversation history, classifies exact
arguments, shares the Run request budget and records returned usage. Uncertain
or failed judgments ask the user; accounting failure propagates into recovery.
`update_plan` has an explicit non-read-only annotation. Classification quality
is not guaranteed by these deterministic tests or substituted for isolation.

Agent UI consumes model/mode config responses and ordered notifications, blocks
submission during configuration, and prevents a late response overwriting newer
notifications. Its approval inbox binds offered decisions to active requests,
cleans up on cancellation/disconnect and labels each request's Session.

The reusable `scripts/acp-permissions` profile checks **26 v1/v2 scenarios**
through real Gateway, Console, Controller, PostgreSQL and managed-MCP Runtime.
Two execution traces cover **26 Runs, 52 model requests, 16 permission waits and
16 Runtime calls**. Each Smart phase must have exactly one judge request; each
version and phase must use its actual selected model. Each Tool call descends
from Gateway and its Run, starts after approval, and has a Runtime child span.
Denial, cancellation and Chat have zero Tool dispatch. Two cross-user upgrades
are rejected. Trace IDs/relationships are asserted, not just service presence.
No external model provider or packet-level telemetry was used.

Browser acceptance verifies allow once, reject once, Chat mode, usable input
after completion, collapsed Tool details and a 390px-wide approval panel without
horizontal overflow. Browser validation supplements reusable inbox/projection
tests; it does not claim all Session/connection races were visually exercised.

Read-only follow-up review strengthened per-version model and judge assertions
and required cleanup independent of the client. Negative controls cover missing
judge requests, wrong v2 models, missing ownership scope and partial cleanup
failure. A deployed fault profile kills the client container during approval:
expected exit 137 is accompanied by successful API-driven Session/Agent/Runtime
cleanup, without restarting the product. Earlier failed cleanup attempts were
recovered and removed; they are not counted as passing fault acceptance.
Only the coordinator ran tests/Docker/browser actions; reviewers were closed.

Final test metrics: `make test-node` **779 tests passed** (ACP 442 / 54 files,
Console 220, Agent UI 18, reusable fixture tests 99). The full isolated PostgreSQL
suite passed **140 tests / 17 files** in 138.33 seconds, serially. `make lint`
passed: Go zero issues, both Rust Clippy targets with warnings denied, ACP ESLint
and all TypeScript checks. `make fmt-check`, `git diff --check`, ACP production
build and the Agent UI production image passed. Agent UI retains the existing
non-blocking Vite bundle-size warning (534 kB before gzip) and dependency PURE
annotation notices; no threshold was relaxed or warning suppressed.

The profile reuses and updates the existing development stack. Temporary test
containers and Runtimes are reclaimed; synthetic identity/catalog records remain.
The PostgreSQL regression suite used an isolated database and role, both removed
after zero remaining connections. Cleanup is bounded and reports failure if
Gateway is unavailable; it does not claim recovery from a killed wrapper.

F07-F10 remain separate unfinished work. These results complete the named F05/F06
scope, not unrestricted ACP conformance or every cross-service acceptance item.

## Slash Commands F08 (2026-09-09)

This service-owned batch implements [the command contract](slash-commands.md):
one registry owns the `help` handler, localized alias and advertised directory.
Both ACP adapters announce the full catalog on authorized Session setup.
Commands use normal Prompt admission and durable replies, without Provider or
Runtime calls. No command API, table, or polling loop was added.

| Evidence                                                                                                                  | Tests                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Exact parsing, aliases, attachments not reinterpreted, actual handlers                                                    | `test/domain/slash-commands.test.ts`, `test/application/prompt-coordinator.test.ts` |
| No model/credentials/Runtime setup; cancellation, deadline, ownership, persistence failure                                | `test/application/run-executor.test.ts`                                             |
| Catalog on new/load/resume/fork using each official SDK                                                                   | `test/transport/acp-v1-agent.test.ts`, `test/transport/acp-agent.test.ts`           |
| Official wire shapes, history/attachments, application restart, fork, identity/Session isolation and active-Run exclusion | `test/e2e/acp-commands.postgres.test.ts`                                            |
| Official v1 HTTP client, catalog on SSE, command reply before Prompt completion                                           | `test/e2e/acp-http.postgres.test.ts`                                                |

PostgreSQL tests run the real ACP application and transport against a dedicated
test database; Controller, Provider and Runtime ports use deterministic fixtures.
Restart coverage reconstructs the application on the same stored Session, not
a container crash. Catalogs are connection setup data, not replayed message rows.
HTTP setup responses and the notification SSE stream have independent delivery.
The service batch alone has no Gateway/Runtime/Jaeger or browser evidence;
the separate deployment result follows below.
At the F08 completion point F07 stayed deferred and F09/F10 were unimplemented.
The F09 service batch below supersedes that F09 status, not its deployment limits.

Final service verification: **465 ordinary tests / 55 files** and **147
PostgreSQL tests / 18 files** passed serially. F08 adds 23 ordinary cases and
7 PostgreSQL protocol cases; existing exact notification assertions now include
the real catalog without weakening history or isolation checks. Production
TypeScript build, repository `make fmt-check`, `make lint` and `git diff --check`
passed (Go 0 issues, both Rust Clippy gates, ACP ESLint/types and both frontend
type checks). The dedicated database had zero remaining connections. The
PostgreSQL container, volume and five database networks created for this test
batch were removed; no test/build/lint subprocess remained.

### Gateway Deployment Acceptance

`make e2e-slash-commands` passed with the current images in an isolated Compose
project. The [reusable fixture](../../../scripts/acp-commands/README.md) uses
Gateway APIs for all setup and cleanup, one PostgreSQL instance with separate
service databases, the official ACP SDK, real Runtime Bash and Jaeger. The model
is deterministic; no external credentials or direct database queries are used.

| Final evidence                      | Result                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 HTTP, v1 WebSocket, v2 WebSocket | 3 transports; 6 completed help Runs                                                                                                                  |
| Commands and restoration            | Exact 4-message history per Session, preserved file reference, load/resume, no-replay resume, fork and fresh catalogs                                |
| Rejections                          | 3 cross-user, 9 cross-Agent Session, 3 unsupported embedded-content requests                                                                         |
| Ordinary execution after help       | 2 completed Runs, 2 real Runtime Bash effects, 4 correlated model requests                                                                           |
| Command/restore/isolation traces    | 9 traces; Gateway ancestry, command persistence and admission closure; zero model, credential or Runtime execution                                   |
| Ordinary execution traces           | 2 traces; Gateway ancestry through ACP/Controller to real Runtime child spans                                                                        |
| Fixture oracle tests                | 6 positive/negative groups; missing history, duplicate replies, v1/v2 Tool shape, terminal ordering, missing/orphan spans and extra execution reject |

HTTP/SSE deployment exposed an actual Gateway defect: a reverse-proxy abort
unwound the HTTP handler before its span ended. Gateway now uses deferred
finalization without swallowing the panic or replacing a committed response.
Regression cases cover normal completion, `http.ErrAbortHandler`, and panic
before/after headers; all 7 Gateway packages passed normal and race tests. The final complete
deployment rerun passed after this repair, not merely its business assertions.

Controller does not yet advertise `embeddedContext`. Service tests enabling
embedded text do not prove that deployment capability; the integration verifies
explicit rejection and preserves accepted `resource_link` content instead.
Enabling embedded resources remains F09 work, not an F08 admission bypass.

## Multimodal Input F09 ACP Service Batch (2026-09-09)

This is a single-service delivery, not complete F09 production acceptance.
The [input contract](multimodal-content.md) defines native WAV/MP3 audio and PDF
forwarding, bounded content validation, admitted model flags and pending service
batches. Existing text, image and reference behavior remains covered.

| Evidence                      | Final result                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Complete ACP ordinary suite   | 502 tests / 57 files passed; 37 new cases since F08                                                                                      |
| Complete ACP PostgreSQL suite | 154 tests / 19 files passed; 7 new cases since F08; 142.65 s, one worker                                                                 |
| Repository lint               | Go 0 issues, both Rust Clippy targets, ACP ESLint/typecheck and both UI typechecks passed                                                |
| Native model conversion       | Exact audio/PDF bytes and order, text-only output request, existing credential/signal; no additional fetch/upload                        |
| Wire/persistence              | v1 HTTP and v1/v2 WS input; retained binary history, fresh application load/resume, fork and cross-Agent denial                          |
| Negative paths                | Undeclared audio, malformed/oversized input, unsupported MIME, selected-model mismatch; failed Run closure and subsequent successful Run |
| Recovery regression           | Audio/PDF flags survive the actual execution-snapshot decoder, including explicit false and absent flags                                 |

Two red regressions were fixed: the recovery decoder stripped native capability
fields, and TurnRunner collapsed typed model-content errors into `run_failed`.
ModelPort now owns bounded typed errors so the application preserves the cause
without importing a model adapter or retaining provider response text.

The service tests use the actual OpenAI-compatible adapter and a deterministic
HTTP response substitute. Small synthetic binary envelopes verify lossless
conversion; they do not prove real speech/document recognition. No external
Provider call, new browser run or new Gateway/Jaeger deployment validation was
performed in this ACP batch. At that boundary Controller had not yet implemented
embedded context/audio declarations or the formal model configuration contract.
The subsequent Controller batch below supersedes that source-code status, not
the lack of F09 UI/deployment acceptance.

Verification was serial. The dedicated `antnest-f09-acp-tests` PostgreSQL
container, volume and networks were removed afterward; retained human-acceptance
instances were not rebuilt or reset.
No new browser or killed-process-recovery result is claimed. Owned containers,
volumes and networks were removed after each run; retained development stacks
were not changed. Runtime image construction also passed 132 Linux module tests,
1 actual UID 1000 executor test, Clippy and release compilation.

Final Node regression: `make test-node` **808 passed** (ACP 465, Console 220,
Agent UI 18, shared fixture tests 105). This batch adds no PostgreSQL schema
change; the earlier 147-test ACP PostgreSQL service result is not a newly rerun
metric. The deployment above independently exercised its real persistence.

## Multimodal Authority (F09 Controller Batch, 2026-09-09)

Controller configuration, catalog metadata, organization-scoped capability
resolution and immutable Run snapshots are implemented. Shared Run contract
revision 11 is accepted by the prepared ACP decoder. Controller normal/race
tests include its actual PostgreSQL and HTTP boundary, with incoming trace
parenting. See [Controller final verification](../../agent-controller/docs/multimodal-input.md#verification)
for the compact metrics and scope. No ACP business code, UI or retained deployment
was changed in this batch. Console/BFF capability preservation was completed in
the following batch below; Agent UI inputs and F09 Gateway/Jaeger deployment
remain pending.

## Multimodal Configuration (F09 Console Batch, 2026-09-09)

The Console/BFF now preserves native capability flags through catalog, profile,
revision, mutation and Agent configuration projections. Known model metadata is
read-only; custom capabilities are independent and explicitly clearable. The
BFF response model uses an allowlist without taking validation authority away
from Controller. Shared Console contract revision 34 records these semantics.
See [Console verification](../../admin-console/docs/multimodal-models.md#verification)
for service tests, build, root gates and synthetic desktop/mobile browser results.
This did not change ACP business code or rebuild retained deployments. Agent UI
and the actual Gateway/Controller/BFF/ACP/Jaeger acceptance remain separate work.

## Multimodal Deployment F09 (2026-09-09)

`make e2e-multimodal` passed against rebuilt images in a disposable Compose
project with one PostgreSQL instance and service-owned databases. All model
profiles, template and Agents were created through Gateway/Console BFF. The
profile uses official SDK v1 WebSocket, v2 WebSocket and v1 Streamable HTTP;
every SessionUpdate is checked against the corresponding official schema.

- 12 Runs: 9 successful native/continuation/restored-model Runs; 3 expected local
  `model_unsupported_content` failures. All admissions close with the correct
  terminal class and zero Tool effects. Failed v1 requests and v2 `_failed`
  notifications are explicitly checked; switching back permits the next Run.
- 9 exact model requests, including unchanged historical image/WAV/PDF bytes,
  UTF-8 text/blob normalization, block order and resource references. The
  reference sentinel records zero fetch attempts. No external Provider is used.
- 6 invalid inputs rejected before admission; 9 cross-Agent Session operations
  and 3 cross-user entrances denied. Reconnect/load/fork preserve 4 messages per
  transport without Provider calls or duplicated setup/history notifications.
- 9 converged Jaeger traces: Gateway ancestry, Controller admission/closure,
  ACP persistence, Runtime information/catalog preparation and exact Provider
  span correlation. No Tool execution, attachment body or credential in traces.
  A failed model attempt uses an atomic SQL finalization, not an invented
  requirement for a message-append transaction.
- 6 reusable fixture/oracle tests cover byte/order/history corruption, missing
  or detached spans, wrong terminal class and reference-fetch detection. The
  read-only review's terminal-notification, fork-buffer and URL-sentinel findings
  were addressed before the passing deployment run.
- F08 was rerun against the same new images: 6 commands with embedded-text/link
  history, 3 ZIP rejections, 12 foreign-Agent/user rejections, 2 actual Runtime
  Bash Runs and 11 Jaeger traces passed. Commands made zero model requests;
  the ordinary Tool Runs made 4. Its 6 oracle tests also passed.
- Final admission: `make -j1 fmt-check lint`, both fixture suites and shell
  syntax checks passed. Go reported zero lint issues; both Rust Clippy gates,
  ACP ESLint/typecheck and both frontend typechecks passed. Agent UI's existing
  non-failing bundle-size/Zod build warnings remain, with no threshold changes.

All test-owned containers, volumes and networks were removed. No service
implementation or schema change was needed in this integration batch. See
[the test profile](../../../scripts/acp-multimodal/README.md) for the command and
scope. This proves platform native delivery, not arbitrary MIME conversion,
Provider recognition quality, killed-process recovery or real deployed browser
acceptance; the latter retain their own stage-closeout scenarios.

## Session Cost F10 ACP Consumer (2026-09-09)

Scope: ACP-owned consumer only, following [Session cost](session-cost.md).
The future optional Controller price field is accepted and validated; its
producer contract and administrative endpoints are not implemented by this
batch. No schema migration or additional billing table was introduced.

| Evidence                          | Executable coverage                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pricing and known-cost projection | `test/domain/usage.test.ts`: Provider priority, zero vs missing, USD, cache subsets/fallback, frozen rates, bounded accumulation                                                                                                      |
| Actual JSON/SSE adapter           | `test/adapters/model/cost.test.ts`: normalized measured tokens, invalid metadata, partial/repeated usage snapshots, valid receipts on invalid completion or interrupted stream                                                        |
| Error and judge accounting        | `test/application/turn-runner.test.ts`, `permission-judge.test.ts`: account before final output failure or classifier fallback; persistence failures propagate                                                                        |
| Private persistence               | `test/adapters/postgres/usage.postgres.test.ts`: concurrent same-ID retry, conflicting IDs, terminal-race barrier, restart snapshot, unchanged replay, independent fork baseline                                                      |
| Standard wire projections         | v1/v2 transport tests compare exact standard `usage_update.cost`, excluding private receipt fields                                                                                                                                    |
| Real service boundary             | `test/e2e/acp-cost.postgres.test.ts`: v1/v2 WebSocket, real application and PostgreSQL, reported/estimated/unknown amounts, reconnect/replay, new Session isolation; deterministic model responses and Controller/Runtime substitutes |
| Price consumer readiness          | Controller adapter tests accept the proposed optional field, reject invalid rates/currency, and preserve old no-price responses; not a claim that the production Controller emits prices                                              |

Two read-only adversarial reviews found and corrected lost usage on failed
outputs, invalid token/cache metadata, partial SSE snapshots, terminal-state
retry races and cumulative-baseline overflow. All findings received reusable
tests; reviewers ran no shared-resource verification.

Final coordinator-run metrics, executed serially on the final code:

- `npm --prefix services/agent-acp-service test`: 59 files, 535 tests passed.
- `npm --prefix services/agent-acp-service run test:postgres` with the disposable
  test database: 21 files, 159 tests passed in 120.92 seconds. No skipped database
  tests or external Provider calls were counted as passed.
- `npm --prefix services/agent-acp-service run build`: passed.
- `make -j1 fmt-check lint`: passed; Go lint reported zero issues, both Rust
  Clippy gates and all TypeScript/ESLint gates passed without relaxed rules.
- `git diff --check`: passed. Only the test-owned PostgreSQL container was used;
  retained development deployments were not rebuilt or reset.

Pending at this ACP-only batch boundary: Controller pricing authority and shared producer contract, Console
editing, Agent UI cost presentation, and deployed Gateway/Jaeger integration.
Known cost is partial accounting, not an invoice. This service batch cannot
close all of F10 or the single-node stage.

## Session Cost F10 Deployed Integration (2026-09-10)

F10's service-owned batches are followed by `make e2e-session-cost`, using
current images in a disposable Docker deployment with one PostgreSQL instance,
separate service databases and a deterministic local model. All administrative
configuration goes through Gateway/Console; no test writes other services' tables.
The official ACP SDK drives v1 WebSocket, v2 WebSocket and v1 Streamable HTTP.

| Evidence               | Final result                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixture/negative tests | 11 passed, 0 failed; includes actual SDK sanitization, raw-frame privacy, foreign notification mutations, held model response and shell process-state failures                 |
| Model execution        | 52 exact requests and completed Runs; no Tool execution or external Provider spend                                                                                             |
| Price precedence       | Reported USD over configured prices, reported zero with nonzero rates, explicit free rates, unknown prices, cache-specific prices and ordinary-price fallback                  |
| Revision semantics     | Old Agent-default pin preserved; selection before a new revision resolves that revision at admission; revision published during a held model request affects only the next Run |
| Restart/replay         | One real ACP container restart; 9 business Sessions restored across three profiles plus the independent observer; repeated replay/fork causes no extra model requests          |
| Model recovery         | Both returned config options and actual first post-restart execution preserve the parent/fork choices without reselecting them                                                 |
| Isolation              | 9 cross-Agent Session operations and 3 foreign-owner entrances rejected; an authorized second owner's live connection retains its distinct USD 0.77 baseline                   |
| Raw wire               | Complete incoming frames inspected before SDK field stripping, including notification metadata and response bodies; private receipts/prices absent                             |
| Jaeger                 | 11 execution/recovery/refusal traces plus 19 price-management traces; 52 actual model requests correlated to unique model spans; causal Gateway ancestry verified              |
| Cleanup                | Test-owned containers, dynamic Runtimes, workspaces, volumes and networks removed; retained development deployments unchanged                                                  |

Execution traces contain 7,949 spans in this final run. Their oracle checks
Controller admission and closure RPC ancestry, ACP durable writes, Runtime
information/catalog preparation and exact model-request/span correspondence.
Pricing traces require Gateway -> Console -> Controller ancestry, not merely
service-name presence. All checked traces are credential-free. Example trace
IDs are `667446a21002efe0bc87cc9591f14173` (v1 WS execution),
`283cd13a2476d5a509887235e2e2ab66` (v2 recovery) and
`8120918740f4aed64f9d65f60460e35d` (price revision).
Jaeger was removed with the test stack; these are reproducibility references,
not permanent links or retained raw evidence.

Read-only review strengthened the oracles rather than changing product behavior:
inspect raw frames before SDK sanitization, preserve notification logs, assert
restored options, hold an admitted request during repricing, and reject failed
container inspections instead of interpreting a running container's zero exit
code as success. Reusable negative tests cover these failure modes.
The final read-only re-review confirmed these five corrections and was closed.
Coordinator admission passed `make -j1 fmt-check lint` (zero Go lint issues,
both Rust Clippy gates, ESLint and all TypeScript checks), the 11 cost fixture
tests and 6 reused trace/model fixture tests, shell syntax, `git diff --check`
and local-link validation of 7 changed documents (126 links). No thresholds,
baselines or lint suppressions were changed. This integration batch changed
test tooling/documentation, not service production behavior.

Scope limits: model receipts are synthetic, and known cost remains partial
accounting rather than a bill. This profile does not call Tools, perform an
in-flight process kill, invoke external paid Providers or repeat deployed browser
acceptance. The [Agent UI evidence](../../agent-ui/docs/session-usage.md#verification)
owns presentation tests. Full single-node browser/operations acceptance still
belongs to C1-C6; F07 remains deferred by the user's SDK decision.

## Current Verdict

F09's Agent UI consumer batch is also verified: negotiated file selection,
native standard Prompt encoding, history presentation and preview ownership.
Its [service evidence](../../agent-ui/docs/multimodal-input.md#final-service-evidence)
includes real React App lifecycle tests and the actual SDK with a synthetic
browser peer. F09's protocol deployment integration is now verified above;
the broader single-node browser and operational closeout remains separate.
F10's ACP, Controller, Console/BFF and Agent UI batches, followed by the deployed
cost integration above, are also verified within their stated accounting scope.

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
