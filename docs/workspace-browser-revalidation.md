# Historical Workspace browser acceptance migration

Superseded on 2026-09-25 by the Agent UI Node Bridge C4 HTTP/SSE browser
profile. The `browser-run.mjs` entry now invokes C4; this report describes
the earlier ACP WebSocket candidate only.

Date: 2026-09-21. Acceptance assets only. The former manual `browser-run.mjs`
entry now runs repeatable Chromium acceptance through `make e2e-workspace-browser`.
The [contract](../tests/e2e/workspace-closeout/browser-migration-contract.md) keeps
its four original prompts and real effects while replacing retired ModelProfile
revision writes, manual finish input and connection-level Trace assumptions.
The [larger C4 browser suite](c4-browser-revalidation.md) remains independent.

## Current behavior and evidence

The profile uses the current Foundation deployment with isolated subnets,
immutable Runtime image, current Provider/Model APIs and a revision-pinned
Template. The browser signs in through Agent UI, chooses its scoped Agent,
appends a real workspace note with bash, reads it, uploads exact markdown/image
bytes, rejects an unsupported file, reloads the original Session and creates a
new mobile conversation. Model calls are the same six controlled requests for
four Runs; only the first two prompts call a Tool.

Assertions cover initially collapsed Tool activity, expanded real output, exact
attachment previews, one copy of answers/attachments after reload, readable
mobile text, 44px controls, no horizontal overflow, and no private Provider or
Runtime fields in browser payloads. Public Run/event audits and the model ledger
must remain unchanged across reload. Exact workspace bytes prove no repeated
append. Runtime process identity comes from the actual Runtime status endpoint
and is checked against all four Run/model execution snapshots.

A Chromium CDP recorder captures the real WebSocket handshake response Trace ID
and new/load/prompt JSON-RPC request IDs. A localhost Chromium/WebSocket component
test proves that identical JSON-RPC IDs on distinct connections retain distinct
Trace/Session identities. Unit/contract tests reject invalid handshake identity,
duplicate requests, wrong Provider/Model, foreign Run snapshots, missing durable
closure, unexpected Tools/model calls, missing parents and error spans.

The browser closes before normal service flush and full Trace collection. All
request traces retain their actual connection link and Session identity; fresh
load is checked independently from prompt execution. Explicit Delete removes the
Agent Runtime and volume, then the runner cleans only its disposable project.
The old manual finish helper and tests were retained in this migration batch;
the later [finish-helper retirement](browser-finish-retirement.md) removes only
that unused export and its exclusive tests.

Private logs and retained-environment baseline are under
`artifacts/verification/workspace-browser-migration-20260921/`; raw migrated profile evidence is
under `artifacts/verification/lifecycle-workspace-browser/<project>/`.

## Verification

The initial local gate passes 102 Workspace tests; the added real Chromium
component check also passes. Project `antnest-lifecycle-076cc854` passes all five
browser check groups, four Runs, six model requests, exact replay/bytes and all
thirteen topologies (two lifecycle commands and eleven browser requests).
Missing parents and error spans are zero; five strict timing results remain
failed, with the profile retaining exit 2.

Screenshot review confirms desktop replay/attachments and mobile layout. The
initial attachment screenshot remained at the expanded Tool output after manual
scroll interaction. The final driver explicitly scrolls to the attachment
response, asserts both attachment cards are inside the viewport, and separately
captures the Tool output. This is a capture correction, not a service/UI change.
Final project `antnest-lifecycle-0bc25f4b` passes all five browser check groups,
four Runs, six model requests and thirteen topologies. All eleven browser request
traces pass strict checks; Create and Delete retain strict timing failures
(139.284 µs, -201.709 µs and 281.829 µs calculated clock deltas). The profile
therefore still exits 2. Missing parents and error spans are zero. All four final
screenshots were inspected: expanded Tool output, visible attachment cards and
rejection feedback, replayed history, and mobile conversation.

The final shared suite passes 1,241 checks, with five pre-existing opt-in ACP
PostgreSQL commit-receipt fault checks skipped and no failures or cancellations.
This includes unit/contract negatives and the real Chromium/WebSocket component.
No production service change requires a new service build in this batch.

The independent existing C4 regression uses project `antnest-lifecycle-148f8a5d`,
with its private report in `artifacts/verification/c4-browser-2026-09-21T13-06-00-954Z/`. All eleven
browser check groups pass, including file/model-capability rejection, approval,
cross-Session cancellation, offline completion, close/reopen, Rebuild, revocation,
Session metadata and mobile/privacy checks. Ten saved Trace topologies pass the
existing profile's checks. Four strict timing results fail; its intentional model
cancellation retains the profile's existing separate diagnostic handling. The
runner reports `browser_passed`, strict failure and verified cleanup (exit 1).

Independent cleanup confirms all three disposable projects have no remaining
owned containers, volumes or networks. The twelve retained development containers
keep their original identities, images, mounts, networks, start times and restart
counts; all run and the eleven configured health checks remain healthy. No
verification/browser child processes remain. Private evidence directories/files
are restricted to modes 700/600. Formatting, local documentation links and
`git diff --check` pass.

No production service, image, retained development data, clock or export interval
is changed. Strict timing failures remain recorded and are not a full-platform
acceptance pass. The old broad C4 milestone, unknown-effect automatic reuse and
historical crash diagnostics retain their prior scope. Remaining historical
entry points and shared helper consumers need an explicit retirement audit
before deletion; no historical directory is removed in this batch.
