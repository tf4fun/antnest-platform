# Structured Plan Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the file/Plan
acceptance migration worktree. All **12 business scenarios** and **38 independent
request trace topology/privacy checks** passed. Strict Trace failed on recorded
timing warnings: the driver exited 1 and `make` exited 2. Production services,
system clocks and warning gates were unchanged. This is scoped business/topology
evidence, not a full strict deployment pass.

## Current Contract And Preserved Coverage

The [Plan driver](../tests/e2e/acp-plan/README.md) creates a Provider connection
and Model, references the stable Model identity from a Template, uses the
returned Template revision and waits for executable Agent readiness. Exact ACP
resource denials replace the obsolete expectation of a rejected authenticated
WebSocket upgrade.

All six phases run through both ACP versions: create, execute/update, invalid
plan, clear, recall, and execute a new Run on a pre-clear fork. Full entries,
order, priority and status remain exact. The replacement removes an entry and
leaves one unfinished; Run completion must not silently complete it. Test gates
require each plan update to arrive before the final model response. The model
checks the authoritative Run-start snapshot, including empty-after-clear and
the fork's independent earlier plan. Tool IDs must remain distinct across Runs;
mixed remote-write/local-plan call/result ordering remains enforced.

The current execution oracle correlates each actual model HTTP CLIENT span to
its `model.complete`, owning `agent.run`, Run identity, prompt Session, Agent
and Gateway connection link. It checks complete topology, committed PostgreSQL
transactions containing a driver write, one fresh Runtime information/catalog
read before model execution, and zero management calls inside a Run. Only each
version's execute phase may dispatch a remote Tool, named `write`, with the
matching Runtime SERVER/Tool descendants. All other phases, including invalid
local plans, must have zero remote Tool invocations. Invalid arguments are a
handled Tool result and do not waive unrelated execution error diagnostics.

The driver collects every successful replay/fork and access-denial request
independently. Repeated loads of the same Session are selected by their actual
connection link; missing, ambiguous or truncated query results fail. Successful
forks match the returned Session identity. Each trace requires the correct
method, Agent and Session, with no Run, model or Runtime execution. Denied wire
requests require exact `access_denied` / `session_access_denied` responses and
zero private updates. Their diagnostics are limited to the rejected ACP request
and its corresponding domain operation. Unknown transport errors cannot pass.

Execution, replay and denial traces all reject payload capture and private
plan/prompt/credential sentinels. Collection follows Agent deletion and Runtime
telemetry shutdown and requires three equal span-ID samples one second apart.
This is bounded export convergence, not a guarantee against arbitrarily late
telemetry or proof about every service stdout/metrics stream.

The Plan-only Compose override ignores local `.env`, removes the host Temporal
port and reserves dynamic ranges separate from fixed Egress/Jaeger addresses.
Gateway, Identity, Controller, ACP, Rust Runtime, PostgreSQL, Temporal and Jaeger
are real; the external SSE model is deterministic and uses synthetic credentials.
No production service implementation, paid Provider or browser was changed.

## Evidence

The existing verified images were reused without rebuilding:

| Image | Immutable ID |
| --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |

New tests first reproduced missing setup/request modules and the old execution
oracle's retired span assumptions. The final **58 local tests** passed with no
failures, skips or cancellations: 16 Plan, 14 file, 16 progress, ten shared
model/Trace collector and two Docker-wrapper tests. These include wrong model
HTTP parents, missing committed driver writes, local-plan forwarding, wrong
resource/socket identity, repeated-query ambiguity, unrelated denial errors,
secret capture and preservation of strict warning failures. Shell syntax,
JavaScript formatting, rendered deployment wiring/isolation and Git whitespace
checks passed.

The full Docker run used project `antnest-stage3-e2e-66314`:

| Evidence | Recorded result |
| --- | --- |
| Business scenarios | All 12 phases matched expected outcomes across v1/v2 |
| Model and local plan work | 22 validated model requests, six plan updates and two invalid-plan rejections |
| Runtime effects | Exactly two actual Runtime writes; local plan operations never dispatched as Runtime Tools |
| Durable replay and fork | Exact nonempty plan/Tool event streams, order and IDs retained; pre-clear fork independent from source clear |
| Resource isolation | Two foreign-user and four cross-Agent Session denials, exact error contracts and zero private updates |
| Execution traces | 12 distinct traces/Runs; all topology, persistence, correlation and privacy checks passed, with zero unexpected error diagnostics |
| Non-execution traces | 20 successful replay/fork plus six denial traces, all with exact identities and zero Run/model/Runtime execution |
| Strict timing | Five execution and 15 non-execution traces failed on timing warnings; the remaining 18 had none |

Execution warning deltas were 152.564, 245.584, 294.131, 437.964 and 462.207 µs
at Gateway-to-ACP starts. The v1 recall trace also recorded −1.175187 ms on a
Runtime HTTP boundary: SERVER starts 1,427 µs after CLIENT and ends 923 µs after
it. Non-execution deltas were 36.12–713.521 µs at Gateway-to-ACP boundaries.
Jaeger repeated warnings through descendants: 1,677 execution and 981
non-execution entries, not that many independent faults. These observations
alone do not establish physical clock drift. The existing
[timing maintenance deferral](controller-acp-execution-boundary-plan.md#obs-acp-clock)
remains; no threshold, timestamp or strict result was changed.

Independent Compose and Runtime-scope label scans found no owned containers,
volumes or networks, and resource-name scans also found none. No verification
child processes remained. All 12 retained development containers kept the same
IDs, image IDs and health state. Development data, rollback images and private
backups were not part of cleanup.

## Retired Asset Mapping

Only after this deployed evidence was collected, `inspectReplayTrace` and its
obsolete connection-wide fixture test were removed from `acp-files`. Its final
acceptance-driver consumer was the Plan client; an import search
confirmed no consumers remained. The replacements are:

| Previous obligation | Current replacement |
| --- | --- |
| Real load/resume and fork traces exist | Files collect 48 message traces; Plan collects 20 successful replay/fork traces by method, Session and actual socket link |
| Replay invokes no model or Runtime | Both current request inspectors also reject `agent.run`; negative tests cover execution injection |
| Gateway ancestry and private-content boundary | Full parent/identity/link checks plus disabled capture and encoded sentinel tests |
| Denial connection evidence | Six actual denied requests with exact wire contracts, scoped rejection diagnostics and no execution |

The final 58-test gate passed after removal (59 passed beforehand; one obsolete
fixture was retired). The old dated reports remain intact; no directory or
unmapped scenario was deleted. Other migrations are in the
[asset inventory](acceptance-asset-migration.md), with slash commands next.

Ignored local evidence is under `artifacts/verification/legacy-acceptance-20260917/`:
`plan-red.log`, `plan-gates-final.log`, `plan-docker-1.log`, `plan-result.json`,
`plan-summary.json` and `plan-cleanup.json`. Results retain compact warning and
timing details. Raw service logs that could contain credentials were omitted;
cache files are not guaranteed in a fresh clone.
