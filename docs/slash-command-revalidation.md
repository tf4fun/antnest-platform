# Slash Command Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the file/Plan/command
acceptance migration worktree. All **three transport profiles** and **40 distinct
JSON-RPC request trace topology/privacy checks** passed. Strict Trace failed on
15 timing-warning traces: the driver exited 1 and `make` exited 2. Production
services, system clocks and warning gates were unchanged. This is scoped
business/topology evidence, not a full strict deployment pass.

## Fixture Contract Repair

The [command driver](../tests/e2e/acp-commands/README.md) uses current Provider/Model
creation, stable Model identity, the returned Template revision and executable
Agent readiness. Foreign users are initialized through the official SDK and
must receive the exact ACP `access_denied` response to `session/new`, on v1
WebSocket, v1 HTTP and v2 WebSocket. Authenticated upgrade/initialization is not
resource access. Cross-Agent load/resume, fork and prompt still require exact
`session_access_denied` responses with no extra private data or notifications.

WebSocket message observation records the SDK's actual JSON-RPC IDs without
changing the messages. It retains only request/method/Session metadata; prompts
and credentials are not copied into evidence. Repeated methods on one socket
are located by request ID and their actual connection link. HTTP uses the SDK's
fetch hook to record each POST's `X-Antnest-Trace-ID` response header. It sends
no invented client Trace parent, and requires complete Gateway HTTP CLIENT/SERVER
and ACP HTTP/dispatch ancestry. Requests use the existing bounded helper and
the SDK's `cancellationSignal`, with owned connection closure on timeout.

Command Runs require current Run identity and committed PostgreSQL transactions
with an actual driver write. They must not call model, Runtime, MCP or credential
resolution operations; no Run may call management services. The two ordinary
positive controls correlate each Provider HTTP CLIENT ID through `model.complete`
to its Run, with fresh Runtime preparation and exactly one actual Bash dispatch
and Runtime Tool descendant. Setup, restore and rejected requests must have no
Run/model/Runtime execution. Allowed rejection diagnostics stay on the matching
ACP request and domain operation; unrelated errors still fail.

The first deployed attempt completed all business checks but failed the v1
ordinary Trace privacy check. The old fixture used `acp-closeout-model` as both
API key and hostname; the current HTTP instrumentation records `server.address`.
The command profile now uses the distinct hostname `commands-model-peer` while
retaining the original synthetic key and its full privacy check. The setup
regression first failed before this repair. No secret exception or Trace-field
exclusion was introduced, and the shared closeout model was not modified.

The command-only Compose override ignores local `.env`, removes the Temporal
host port and separates dynamic ranges from fixed Egress/Jaeger addresses.
Gateway, Identity, Controller, ACP, Rust Runtime, PostgreSQL, Temporal and Jaeger
are real services. Only the model is deterministic. The fixture has no Docker
socket or database access; all identities, Agents and Sessions go through
Gateway. Runtime writes stay in the disposable Agent workspace.

## Recorded Evidence

Existing verified images were reused without rebuilding:

| Image | Immutable ID |
| --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |

The new setup, observer and Trace tests first failed before implementation. Final
verification passed **73 local tests**, zero failures/skips/cancellations:
11 command, 16 Plan, 14 file, 16 progress, ten shared model/Trace collector,
two Docker-wrapper and four connection timeout/cancellation tests. Corrupted
fixtures cover wrong IDs and ancestry, missing persistence, extra model/Runtime
execution, unrelated rejection errors, payload capture, secrets and strict
warning failures. Shell syntax, JavaScript formatting, rendered deployment
wiring/isolation and Git whitespace checks passed.

The full rerun used project `antnest-stage3-e2e-68244`:

| Evidence | Recorded result |
| --- | --- |
| Transport coverage | v1 WebSocket, v1 HTTP/SSE and v2 WebSocket all passed |
| Command discovery and execution | One current executable catalog on each setup; `/help` and `/帮助` each replied once per transport, with no usage/Tool updates or model requests |
| Attachments and history | File reference and embedded UTF-8 content retained exactly in four-message history; load/resume/fork replay identical; resume without replay emitted no duplicate messages |
| Rejections | Three unsupported binary prompts, three foreign-user requests and nine cross-Agent Session operations rejected precisely, with no private updates or extra Run/history |
| Ordinary positive controls | v1/v2 each executed one real Bash command and verified its actual settled output; exactly four model requests in total |
| Trace identity | 40 distinct request traces: six command Runs, two ordinary Runs, 17 successful setup/restore requests and 15 rejections |
| Trace assertions | All 40 passed topology, correlation, persistence where applicable and privacy; command/setup/restore/rejection traces had zero model/Runtime execution |
| Strict timing | One command, one ordinary and 13 other request traces failed on timing warnings; the remaining 25 had none |

Positive calculated deltas were 27.998–634.111 µs at Gateway-to-ACP boundaries.
Four HTTP boundaries had negative calculated deltas:

| HTTP request | Calculated delta | Raw ACP SERVER start/end relative to Gateway CLIENT |
| --- | --- | --- |
| Foreign-user new | −636.955 µs | Starts 1,104 µs after; ends 170 µs after |
| Authorized new | −172.664 µs | Starts 311 µs after; ends 34 µs after |
| Replay | −373.506 µs | Starts 642 µs after; ends 105 µs after |
| Cross-Agent prompt | −314.717 µs | Starts 334 µs after; ends 295 µs after |

Jaeger repeated warnings through descendants, yielding 1,587 entries rather than
that many independent faults. Raw timing alone does not prove physical clock
drift. The existing [timing maintenance deferral](controller-acp-execution-boundary-plan.md#obs-acp-clock)
remains; the strict result was not converted into success.

Independent scans covered the first attempt `antnest-stage3-e2e-67456` and final
rerun: Compose and Runtime ownership labels, resource names and verification
processes were clear. All 12 retained development containers kept the same IDs,
image IDs and health state. Development data, rollback images and private
backups were not part of cleanup.

## Retired Asset And Scope

After the deployed replacement passed business/topology/privacy checks, the old
`evidence.mjs` command Trace validator and its three admission/finish-era tests
were removed. It had no remaining driver consumers. Current replacements in
`trace.mjs` and `trace.test.mjs` retain the original persistence, no-execution,
ancestry and privacy obligations while adding exact request identity and HTTP
boundaries. The catalog, transcript and actual Tool-result validators remain.
The 73-test final gate ran after retirement.

This verifies the 40 declared JSON-RPC request traces; independent background
HTTP SSE/connection-close traces are not included in that count. Actual SDK
SSE delivery is exercised by the HTTP business and transcript checks. No browser,
forced crash, paid Provider, all-telemetry-stream or universal protocol conformance
claim is made. The [asset inventory](acceptance-asset-migration.md) tracks the
remaining groups; the subsequent [Tool permission migration](tool-permission-revalidation.md)
adds disposable deployment and an independent client-crash cleanup control.

Ignored local evidence is under `artifacts/verification/legacy-acceptance-20260917/`:
`commands-red.log`, `commands-hostname-red.log`, `commands-gates-final.log`,
`commands-docker-1.log`, `commands-docker-2.log`, `commands-result.json`,
`commands-summary.json` and `commands-cleanup.json`. These contain compact
results and warning/timing details; raw service logs that could carry credentials
were omitted. Cache artifacts are not guaranteed in a fresh clone.
