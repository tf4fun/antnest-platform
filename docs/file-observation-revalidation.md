# File Observation Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus this fixture and
documentation batch. All **16 business scenarios**, **16 execution trace
topology checks** and **48 independent replay/fork trace checks** passed.
Strict Trace failed on recorded timing warnings: the driver exited 1 and `make`
exited 2. This is scoped business/topology evidence, not full strict acceptance.
Production implementations, system clocks and warning gates were unchanged.

## Contract Migration

The [file driver](../scripts/acp-files/README.md) now creates a Provider
connection, reads its stable Model identity and uses the returned Template
revision. It waits for executable Agent readiness. It rejects an ambiguous
Model inventory instead of selecting an arbitrary item.

The first Docker attempt reproduced the retired expectation that Gateway denies
a foreign Agent's authenticated WebSocket upgrade. Current Gateway authenticates
the connection; ACP authorizes resource access. The repaired test initializes
the foreign client and requires `session/new` to reject with JSON-RPC code
`-32020`, `data.code=access_denied`, and zero private updates. A successful
request, generic disconnect or unrelated error cannot satisfy this check.

The execution oracle now follows the model's actual propagated HTTP CLIENT
span through `model.complete` to its owning `agent.run` and `antnest.run.id`.
It requires Gateway ancestry, Runtime preparation before model execution,
exactly one real Tool dispatch/invocation and no management calls inside a Run.
Only intentional failed-edit Tool subtrees may contain errors.

Each replay/fork message has its own trace. The driver collects the original
Session load/resume, fork, and fork load/resume separately for every scenario.
Each of the 48 traces must match the actual method, Session and WebSocket link,
with no Run, model or Runtime execution. Missing/ambiguous traces fail; stable
collection still requires three identical span-ID sets one second apart.
Full topology, disabled payload capture and encoded credential/content-sentinel
checks apply to execution and replay. At the end of this first batch, the old
connection-wide replay helper was retained for Plan. The subsequent
[Plan migration](structured-plan-revalidation.md) removed it after its final
consumer gained current request evidence and replacement fixture tests passed.

The file-only Compose override ignores local `.env`, removes the Temporal host
port and separates dynamic addresses from fixed Egress/Jaeger IPs. The profile
uses synthetic accounts and a deterministic external SSE model with real
Gateway, Identity, Controller, ACP, Rust Runtime, PostgreSQL, Temporal and Jaeger.
File operations flow through real Runtime MCP; no MCP result is fabricated.

## Recorded Evidence

Existing verified images were reused; no production rebuild was required:

| Image | Immutable ID |
| --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |

New setup/Trace tests first failed before implementation. The exact ACP denial
regression was also added before its repair. Final local verification passed
**43 tests**, with zero failures/skips/cancellations: 15 file fixtures, 16
progress fixtures, 10 shared model/Trace collector tests and two Docker-wrapper
tests. Shell syntax, JavaScript formatting, rendered deployment-contract and
Git whitespace checks passed. These checks do not replace deployed evidence.

The full run used project `antnest-stage3-e2e-64833`:

| Evidence | Result |
| --- | --- |
| Eight scenarios per ACP version | Create, full edit, read, empty create, empty replace, unchanged edit, large write and deliberate failed edit all matched expected outcomes |
| Model/Tool execution | 32 validated model requests; exactly 16 ACP dispatches and 16 actual Runtime Tool calls |
| File events and replay | Official SDK update schemas, exact file facts, v2 patch application and identical durable Tool replay/fork events passed |
| Cross-user isolation | Two exact ACP denials with no private updates |
| Execution traces | All 16 topologies passed; only the two intentional failed-edit traces had Tool errors, five expected error spans each |
| Replay/fork traces | All 48 distinct message traces passed identity, ancestry, privacy and no-execution checks |
| Strict timing | 10 execution traces and 24 replay/fork traces failed; 30 other traces had no warnings |

Nine execution warning deltas were 5.426–597.121 µs, with ACP SERVER starts
preceding Gateway CLIENT starts. The v2 failed-edit trace had a −1.33435 ms
calculated delta on the Runtime boundary: SERVER starts 1,517 µs after CLIENT
and ends 1,151 µs after it. Replay warning deltas were 31.368–617.34 µs, all at
Gateway-to-ACP boundaries. Jaeger repeated these warnings through descendants
(3,753 execution entries and 1,832 replay entries); these are not counts of
independent faults. Raw timings alone do not prove physical clock drift.
The existing [timing maintenance deferral](controller-acp-execution-boundary-plan.md#obs-acp-clock)
remains in force; no warning is converted into a passing strict result.

The first fixture-failure project `antnest-stage3-e2e-64467` and the full run
both cleaned their owned resources. Independent Compose and Runtime-scope label
checks found no containers, volumes or networks; verification child processes
were gone. All 12 retained development containers kept the same IDs, image IDs
and health state. Development data, rollback images and private backups were
not part of this cleanup.

Ignored local evidence is under `.cache/legacy-acceptance-20260917/`:
`files-result.json`, `files-summary.json`, `cleanup-result.json`, red-test logs
and gate/driver logs. Compact results retain warning/timing details; raw service
logs that could contain credentials were omitted. Cache files are not guaranteed
in a fresh clone. Other historical assets remain tracked in the
[migration inventory](acceptance-asset-migration.md); no broader migration,
retirement, browser or external paid-model acceptance is claimed here.
