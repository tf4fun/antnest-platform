# ACP persistence and interruption migration

Current follow-up: [expected absence and crash Trace acceptance](trace-acceptance-followup.md)
separates deliberate SIGKILL diagnostics from normal-request completeness.
The dated runs below retain their original results; they are not retroactively
rewritten as passing strict acceptance.

Date: 2026-09-17. This fixture migration follows the separate
[Controller publication Trace fix](controller-publication-trace-revalidation.md).
The [shared contract](../tests/e2e/acp-persistence/contract.md) was defined before
tests and implementation. ACP production code is unchanged. Historical
Controller admission tables/RPCs are not recovery oracles.

## P1: committed database response loss

The [new fixture](../tests/e2e/acp-persistence/README.md) uses the current public
Provider/Model/Template APIs, installed v1/v2 SDKs, and public execution audits.
A private PostgreSQL wire proxy forwards actual SQL and holds only after the
successful command tag and idle ReadyForQuery. Exact Session/Run scope, executed
binds, explicit transaction boundaries, command results and payload limits are
tested against real PostgreSQL. Rollback, unrelated Sessions and hold expiration
cannot masquerade as the requested committed-response loss. The client has no
database credentials or Docker access.

Three windows run for each SDK: Run intent COMMIT, accepted input/snapshot
COMMIT, and atomic completed-Run persistence. Public audits prove committed
state while the executor lacks the result. The host observes ACP naturally stop
with exit 1, then starts the same owned container and verifies a new healthy
process without an OOM or automatic restart. Rehydration waits for the public
execution state; only its explicit transient HTTP 503 is retried.

An unaccepted intent recovers as failed with
`service_restarted_before_execution` and null execution-outcome fields. An
accepted Run recovers as failed/quiescent/none with
`service_restarted_during_run`. A previously completed Run and its entire audit
remain unchanged. The v2 observer independently reads committed Session output:
it can truthfully emit idle/end_turn while the execution slot still remains busy
awaiting the database receipt. The fixture verifies that distinction instead of
requiring synchronous v1 response semantics from v2.

Project `antnest-stage3-e2e-3903` passed all six fault cases: 12 Runs, eight
successful Runs and real Bash calls, 16 Provider requests, six natural process
failures/restarts and 12 independent reconnect replays. No recovery/replay
executes Provider work. Exact marker reads prove no lost or repeated physical
effect; new execution preserves every prior audit. Agent deletion removed its
Runtime container and volume.

All 32 request/lifecycle/selected-SQL topology and privacy checks passed, with
zero missing-evidence errors. The strict result remains failed on 12 traces:
nine have 2,079 repeated warning entries, the six injected-fault traces conservatively retain
27 database/process error spans, and two lifecycle absence probes remain errors.
Categories overlap. These errors are not globally exempted by a scenario label;
the exact selected SQL and lost COMMIT/autocommit error are required. The profile
returns nonzero and is not described as full strict acceptance.

The earlier four attempts exposed fixture assumptions about post-startup 503,
unaccepted-intent outcome nulls, hidden assistant Tool context and independent v2
durable-output delivery. Each corrected assertion was reproduced in a focused
test before rerun. All five projects were removed and the retained 12-container
development baseline stayed unchanged. Controller used the independent image
`sha256:e7d6da966ebd4e3af1520c41f1612469556b8ccfc0e5e313217c4a67bdb6b69d`;
retained containers and normal image tags were not replaced.

Private evidence is under `artifacts/verification/acp-persistence/<project>/`, including process
observations, exact fault receipts, before/after public audits and raw traces.
Local logs are under `artifacts/verification/acp-persistence-20260917/`; the temporary component
PostgreSQL container and volume were removed. Root wrapper logs and baseline
checks are under `artifacts/verification/legacy-acceptance-20260917/`.

## P2: process interruption and unknown Runtime effects

The [separate P2 fixture](../tests/e2e/acp-restart/README.md) replaces the historical
completed/model-blocked/tool-blocked/tool-inflight recovery assumptions with
current public audit and Runtime protection semantics. Only this batch uses
SIGKILL, after semantic barriers; the host verifies exit 137, unchanged container
identity/restart count and a new healthy process. For an in-flight Tool it first
reads the exact marker and verifies its live PID and absent release file.

Known interrupted Runs become failed/quiescent with none/settled effects.
Unknown Runtime calls become unresolved/quiescent/unknown with source runtime_mcp
and one visible failed Tool result explaining uncertainty. The public state is
offline with `runtime_barrier_required`; a new prompt in another Session returns
that non-retryable domain error and creates no Run, output or Provider work.

Explicit Rebuild is verified by its current public operation, Runtime operation
journal, exact barrier acknowledgement, replaced Runtime/execution identities
and the original physical container's absence. The subsequent Bash read must
return the original marker exactly once. Public audits deliberately redact
Runtime connection details; actual Model Trace context binds the post-Rebuild
Run and public observed execution revision to the replacement Runtime instead.
No database access or projection bypass is added to the client.

Project `antnest-stage3-e2e-10806` passed all eight business cases: 16 Runs (ten
completed, four failed, two unresolved), 14 Tool attempts including 12 successful
Bash calls, 28 Provider requests, eight observed SIGKILL restarts, 18 reconnect
replays, two protective rejections and two Rebuilds. Recovery/replay executes no
Provider work. The original unresolved audit remains unchanged through Rebuild
and later execution. Agent deletion removed its Runtime container and volume.

Of 50 request/lifecycle Trace checks, 44 have complete passing topology/privacy
and protocol evidence. The six intentionally interrupted requests have missing
synchronous parents after SIGKILL and remain explicit missing-evidence failures.
The strict gate fails on 27 traces: those six gaps, 21 warning traces with 863
repeated warning entries, and four lifecycle Docker absence-probe ERROR spans.
The subsequent [raw-span diagnosis](trace-error-span-diagnosis.md) also found six
Runtime `outcome_unknown` ERROR spans inside the two in-flight interruption
traces. The topology assertion runs before error inventory, so the original
results retain only `missing synchronous parent` for those traces. The failed
trace count is unchanged; the original summary was not a complete error inventory.
Categories overlap; no missing parent or error is synthesized or waived.
Both post-Rebuild Run/Model traces bind to the actual replacement Runtime.

Completed setup, replay, denial and ordinary-execution traces are archived before
the next SIGKILL. Failed export blocks another injection; interrupted requests
are excluded from this completion archive and collected from their actual
propagated Model trace IDs after the fault. The previous full business attempt
(`antnest-stage3-e2e-7685`) exposed loss of earlier completed traces during later
faults; its slow collector was deliberately stopped, archived and cleaned as a
failed attempt. Focused archive tests preceded the successful reordered rerun.
All four P2 projects and their Runtime resources are gone, with no verification
children and the retained 12-container baseline unchanged.

The first two attempts corrected current public projection assumptions: an
absent optional unknown-effect source is valid for known effects, and Runtime
connection details are not part of public execution snapshots. Focused tests
reproduced each mismatch before rerunning. Identity deactivation, foreign-Agent
access, and other lifecycle/workspace/retained branches remain separate consumer
obligations. Shared legacy helpers are retained; no directory is retired merely
because these recovery cases have replacements.


## Final local gates and remaining scope

The final combined fixture regression passes 71 tests with zero skips, including
real PostgreSQL and HTTP components, current audit/protocol contracts, archive
ordering, Runtime binding and affected lifecycle/RPC Trace checks. The isolated
PostgreSQL fixture is removed after the run. Formatting, shell syntax and local
document links are checked separately. Controller's earlier full service/race,
PostgreSQL, lint and image-build gates remain in its own report.

These are scoped business/topology results, not full strict deployment
acceptance. Strict warnings, process error spans, interruption export gaps and
Docker probe errors remain open. The independent Controller candidate has not
been deployed to the retained stack. No ACP/Runtime/Gateway/Console production
implementation was changed in P1/P2, and no shared legacy directory was deleted.
