# C4 Browser Revalidation

Recorded: 2026-09-16. Browser/business acceptance passed; the strict Trace gate
still failed. This is a new current-candidate acceptance batch. The
2026-09-11 five-item deferral and its historical accounting remain unchanged.
The later [ACP/Runtime/UI integration batch](acp-platform-integration.md) reruns
this profile against the SDK/metadata candidate and adds a two-page metadata
check. The results below retain this earlier candidate and its ten-check scope.

## Scope And Evidence Contract

| Item | Required current evidence |
| --- | --- |
| C4-01 | Real member login, accessible Agent selection, new/load Session, multiple prompts, real Runtime tools, visible completion and exact workspace bytes |
| C4-02 | Text/image upload bytes received by the controlled model, visible previews and tool results, explicit unsupported format/capability rejection; real approval interaction |
| C4-03 | Two Sessions share authoritative busy state; cancel an active model request; close/reopen and offline completion recover history without repeating model requests or workspace effects |
| C4-04 | A page already open observes normal Rebuild and identity revocation; retained workspace and no internal Runtime address/access subject in browser responses |
| C4-05 | Current Agent UI unit/component and browser-route regressions, plus real Docker desktop/mobile interaction and screenshots |

Use a disposable Docker project with synthetic administrator/member accounts,
real Gateway, Identity, Controller, ACP, Runtime, PostgreSQL, Temporal and Jaeger.
Only the external model is a deterministic HTTP fixture. Never use the retained
development Agent or a real Provider for destructive identity/lifecycle checks.

The fixture uses the current Provider/Model/Template contracts. Model responses
can be held and released to observe busy, disconnect and cancellation boundaries;
the browser's Gateway/ACP traffic is not mocked. Exact per-phase model request
counts and workspace bytes detect accidental prompt or tool replay.

Cancellation uses existing product policy. A canceled model request with no tool
effect must release admission. Cancellation during an unconfirmed tool effect
does not authorize inventing automatic recovery or removing server protection;
that separate policy remains outside this browser-only verification batch.

Run verification serially and remove all test-owned containers, volumes,
networks and browser processes on success, failure or interruption. Preserve
strict Trace failures separately from business/topology evidence under
[OBS-ACP-CLOCK](controller-acp-execution-boundary-plan.md#obs-acp-clock).

## Agent UI Service Batch

Real Docker acceptance reproduced an unsupported-audio request that only showed
`Agent Run failed`. ACP already returns `-32022` with
`data.code=model_unsupported_content`. Agent UI now maps that existing public
code to an attachment-capability explanation with a compatible-model/new-chat
recovery choice. It retains the draft and preview, never submits automatically,
and does not display remote error details. No producer contract changed.

The App regression failed before the fix and passed afterward. Service gates:

| Check | Result |
| --- | --- |
| Node unit/SDK error-contract tests | 69 passed |
| React component tests | 127 passed across 11 files |
| TypeScript + production build | Passed |
| Actual browser + production ACP SDK against wire fixtures | Passed at 320–1440 px; unsupported attachment retains draft/preview, zero implicit retries and browser errors |
| Workspace fixture unit/HTTP/component/Trace checks | 40 passed |

The isolated UI image is `antnest/agent-ui:c4-acceptance`, ID
`sha256:fd20ed07a0c4783e84c9bb2845d6c8ab9d587d269712e9c737992c8816c895bd`.
The retained development stack was not redeployed in this batch.

## Integration Fixture

Run [c4-run.mjs](../tests/e2e/workspace-closeout/c4-run.mjs) using the
[documented prerequisites](../tests/e2e/workspace-closeout/README.md#current-c4-browser-revalidation).
The older interactive runner still seeds retired ModelProfile revision APIs.
The new runner uses current Provider/Model/Template identities and checks the
ACP-scoped Tool call ID against its result; obsolete raw Provider ID assumptions
were reproduced in failing tests before updating the fixture.

The scoped Compose override separates dynamic IP allocation from fixed
Egress/Jaeger addresses and disables the unnecessary host Temporal port.
Browser evidence reads only finite JSON responses, ACP frames and explicit state
snapshots; it does not wait for a never-ending SSE response body. The production
client continues to validate SSE snapshots with its strict schema.

The coordinator handles browser signals so Playwright cannot exit before Docker
cleanup. A real `SIGINT` after browser/Tool completion returned controlled exit 1
and independently verified removal of all project containers, volumes and
networks. Evidence: `artifacts/verification/c4-interruption-result.json`, with the interrupted
project report under `artifacts/verification/c4-browser-2026-09-16T13-31-37-892Z/`.

## Final Docker Evidence

Final report: `artifacts/verification/c4-browser-2026-09-16T13-32-52-000Z/report.json`.
Project `antnest-lifecycle-21ca6fae` used the UI image above and Runtime image
`sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909`.
The final runner returned **exit 1**, with `status=browser_passed`,
`strict_trace=failed`, and `cleanup=verified`.

| Current scoped item | Final result |
| --- | --- |
| C4-01 | Member login, explicit accessible-Agent selection, new/load/reload, multi-prompt conversation, real bash/read and displayed tool output passed |
| C4-02 | Exact text/image bytes, draft/sent previews, unsupported binary rejection, explicit model-audio rejection before any Provider request, and real Allow once approval passed |
| C4-03 | Another Session observed busy and canceled the active model request; admission reopened. Offline completion and close/reopen recovered one history without a new model request |
| C4-04 | An open page observed Rebuild/unavailable/ready, then read the retained file with environment-change context. Member deactivation disabled the Agent and returned the existing page to login with no conversation content |
| C4-05 | Service and browser-route gates above passed; real Docker desktop 1440×1000 and mobile 390×844 passed layout/input checks and screenshot review |

Ten executable browser checks passed. The controlled Provider received 14
requests for nine completed prompts and one canceled model request; the separate
unsupported-audio prompt never reached it. There were four actual Runtime Tool
calls, zero fixture errors/pending requests and zero browser errors. Exact
workspace bytes prove the single append survived Rebuild without duplication.
448 finite browser payloads/state snapshots/ACP frames passed private Runtime
address/access-subject and Provider credential checks.

Nine successful chat traces passed topology and execution ancestry checks, with
zero error spans/events. Eight passed the strict warning gate. The post-Rebuild
trace `b772b8b29d8bff0b0207066bae5ae952` failed on 141 repeated warning entries
with one distinct calculated clock delta, **353.713 µs**. Its 161 spans and one
Runtime Tool call passed structural checks. No timestamps or warning thresholds
were changed. The canceled request's trace is recorded separately with expected
cancellation and validated topology; it is not counted as a successful chat.

The earlier complete run at `artifacts/verification/c4-browser-2026-09-16T13-23-57-482Z/` also
passed business/topology checks, but its revocation screenshot captured only the
transient disabled state. The final run strengthens that assertion to actual
login return. Earlier clock deltas ranged from 12.918 µs to −1.147281 ms; those
strict failures remain recorded rather than replaced by the later smaller value.

Screenshots in the final evidence directory include attachments, capability
rejection, permission approval, Rebuild, mobile conversation and revoked login.
All final test-owned containers, volumes and networks were removed. The UI fix
and acceptance assets are saved with this report; no retained development
deployment was changed. Local evidence has since moved to private ignored
`artifacts/verification/` storage and is not guaranteed in a fresh clone.
The final ownership audit covered all 12 projects created during this batch and
found zero remaining test resources; retained development services remained up
with no unhealthy status. Formatting, whitespace and 71 local documentation
links also passed their checks.

## Acceptance Boundary

The 2026-09-11 deferral remains historical. This batch does not claim automatic
recovery after cancellation of a Tool with unconfirmed effects, nor model
transcription/image-recognition quality. The external model is controlled, and
the offline test uses a failed offline navigation to close the transport before
restoring the page and replaying history. Strict clock-warning failures remain
failures; successful business/topology checks do not override them.
