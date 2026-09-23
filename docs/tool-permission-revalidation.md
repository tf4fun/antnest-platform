# Tool Permission Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the acceptance
migration worktree. All **26 business scenarios** and **30 independent request
Trace topology/privacy checks** passed. Strict Trace failed on 13 timing-warning
traces (driver exit 1, Make exit 2). This batch changes acceptance assets only;
it does not change or deploy production service implementations. The result is
scoped business/topology evidence, not a full strict deployment pass.

## Fixture Contract Repair

The [permission driver](../tests/e2e/acp-permissions/README.md) now owns a
disposable Stage 3 project. It no longer seeds users or catalog records into a
retained development stack. A dedicated Compose override ignores local `.env`,
removes the fixed Temporal port and separates dynamic addresses from fixed
Egress/Jaeger addresses. The direct wrapper refuses execution without the root
disposable owner. Root cleanup stops asynchronous creators and checks both
Compose and Runtime resource scopes.

Provider creation publishes two current Models. The Template references a stable
Model identity, Agent creation uses the returned Template revision, and the
client waits for an executable Runtime binding. Foreign users initialize through
the official v1/v2 SDK and must receive ACP `access_denied` with numeric code
−32020 and no Session updates. Gateway upgrade failure is no longer an access
control oracle.

Both `tool_call` and `tool_call_update` are forbidden before approval. Reconnecting
clients must receive the same pending approval parameters and complete the same
Run after answering. v2 completion/cancellation checks include the Session,
`state_update`, idle state and exact stop reason. Hidden judge text remains
forbidden in chat and exported telemetry.

Each prompt gets its own trace, correlated through the model's actual HTTP
CLIENT span and ACP `agent.run`/`antnest.run.id`. Checks require complete Gateway
ancestry and connection links, committed PostgreSQL persistence, current Runtime
preparation, exact model purposes/stages, wait ownership/outcome and approval
before dispatch. Cached decisions and read-only safe calls must not add waits.
Rejected, cancelled and Chat Runs must have zero Tool effects. Permitted calls
require actual ACP CLIENT → Runtime SERVER → Runtime Tool ancestry.

The first Docker attempt completed all 26 business scenarios and 52 model
requests, then failed an overbroad fixture assertion requiring a Tool catalog
read in Chat mode. Current `ContextBuilder` deliberately omits Tools in Chat.
A new test first reproduced this failure; the validator now explicitly requires
zero catalog reads in Chat and one in every other mode. Runtime information is
still required in every Run. No production behavior was changed.

Independent reconnect traces must contain no additional Run/model/Runtime
execution. Independent foreign-user denial traces require scoped ACP rejection
diagnostics and no execution. Privacy checks cover synthetic credentials,
session cookies, prompt sentinels and payload-capture prohibition. Only deliberate
permission rejections may carry their matching wait's rejected outcome;
unrelated error spans/events still fail.

## Images And Verification

Previously verified images were reused without rebuilding:

| Image | Immutable ID |
| --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` |
| Managed integration Runtime | `sha256:59c0cc5ece8650f8fcbf5134ff42b663ffda6cbd7b1c59d2ae65ec0f6bdc3ed0` |
| Production Runtime base | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |

The managed image adds the official SDK fixture for unannotated Smart calls;
builtin read/write effects use the real Rust Runtime. Gateway, Identity,
Controller, ACP, PostgreSQL, Temporal and Jaeger are real services. Only the
model and managed child are controlled fixtures. Setup/deletion use Gateway
APIs; the client has no Docker socket or direct database access.

The complete rerun used project `antnest-stage3-e2e-70208`:

| Evidence | Recorded result |
| --- | --- |
| Protocol scenarios | 13 each on v1/v2: once, once-again, deny, always, follow, reject, reject-follow, chat, read-hint, judge-safe, judge-ask, cancel and reconnect |
| Model selection | Exactly 52 requests, including four hidden judgments; the first five phases per version used the selected alternate Model and the others used the default |
| Tool effects | 16 actual Runtime invocations: ten writes, two reads and four managed echo calls; rejected/cancelled/Chat phases had none |
| Permission waits | Exactly 16; matching Run/Session and decision outcome; permitted dispatches began after approval finished |
| Prompt traces | 26 distinct Runs with model HTTP correlation, committed persistence, 26 Runtime information reads and 24 catalog reads |
| Recovery and access | Two independent load/resume traces without re-execution, plus two exact foreign-user ACP denials with no execution/private updates |
| Privacy and errors | All 30 passed; no unexpected error span/event was accepted |
| Strict timing | 13 prompt traces had warnings; the other 13 prompt traces and all four recovery/denial traces were clean |

Positive calculated deltas at Gateway-to-ACP boundaries ranged from
38.046–622.811 µs. Two ACP-to-Runtime boundaries reported negative calculated
deltas: −404.552 µs in `v1-cancel` and −654.408 µs in `v2-judge-ask`. Their raw
Runtime SERVER start/end offsets relative to ACP CLIENT were +658/+149 µs and
+1,260/+48 µs respectively. The cancellation occurred during pending approval;
its Runtime activity was preparation, with zero Tool dispatch.

Jaeger repeated warnings through descendants, producing 5,292 entries across
13 traces. These are not 5,292 independent failures. Raw timing does not establish
physical clock drift. The existing
[OBS-ACP-CLOCK deferral](controller-acp-execution-boundary-plan.md#obs-acp-clock)
remains; clocks, timestamps and strict exit behavior were not changed.

Final verification passed **86 local tests**, zero failures/skips/cancellations:
13 permission, 11 command, 16 Plan, 14 file, 16 progress, ten shared model/Trace
collector, two Docker-wrapper and four connection timeout/cancellation tests.
New setup, v2 approval and current Trace fixtures first failed before their
repairs. Negative cases cover incorrect wait counts/outcomes, early effects,
wrong Run/model/connection identity, hidden judge purpose, missing persistence,
extra Runtime effects, secrets and unrelated failures. Shell syntax, formatting,
rendered configuration isolation/publication and Git whitespace checks passed.

## Crash Cleanup And Asset Retirement

The separate negative control used project `antnest-stage3-e2e-70949` with
`ANTNEST_E2E_PERMISSION_CRASH=true`. The client emitted `crash_ready` at its first
pending approval, then the wrapper killed it. Its exit remained **137**, exposed
by Make as exit 2. The independent cleanup container rediscovered the single
UUID-qualified Agent, closed its Sessions through ACP and deleted the Agent
through Gateway/Controller, reporting `cleanup_passed` with `agents: 1`.
The root wrapper then removed all disposable resources. Expected crash failure
was not reported as a passing permission protocol run.

Normal execution deletes Agents before Trace collection to flush Runtime OTLP;
its independent fallback cleanup consequently reported zero remaining Agents.
The wrapper's separate cleanup deadline is bounded at 120 seconds. Independent
final scans covered the first attempt `antnest-stage3-e2e-69443`, complete rerun
and crash project under both Compose/Runtime labels and resource-name scans.
No containers, volumes, networks or verification child processes remained.
All 12 retained development containers preserved their IDs, images and health;
11 health checks stayed healthy and Jaeger has no health check. Development
data, rollback images and private backups were untouched.

After the replacement passed deployed business/topology/privacy checks, the
admission-based Trace fixture was replaced with current tests retaining its
approval-before-effect, real Runtime ancestry and denied-effect rejection
obligations. The current validator additionally checks per-message identity,
HTTP model propagation, persistence, privacy and strict timing. The final
86-test gate ran after retirement. No historical directory was deleted.

This batch covers the 30 declared request traces and automated SDK flows.
The optional browser pause remains available but was not exercised; no new
browser, paid-provider or universal ACP conformance claim is made. Pending work
is tracked in the [asset inventory](acceptance-asset-migration.md); the subsequent
[multimodal migration](multimodal-revalidation.md) adds current native-input,
local capability-failure and per-request Trace evidence.

Ignored local evidence lives under `artifacts/verification/legacy-acceptance-20260917/`:
`permissions-red.log`, `permissions-chat-red.log`, `permissions-gates-final.log`,
`permissions-docker-1.log`, `permissions-docker-2.log`, `permissions-crash.log`,
`permissions-result.json`, `permissions-summary.json`, `permissions-compose.json`
and `permissions-cleanup.json`. Raw service logs with potential credentials were
omitted; ignored artifacts are not guaranteed in a fresh clone.
