# CI latency and retained PostgreSQL coverage

This records the CI feedback, readiness timing and PostgreSQL ownership batches
for [#350](https://github.com/tf4fun/antnest-platform/issues/350). Deduplication
removes duplicate component execution, not business acceptance. Complete remote
CI for the exact candidate remains the merge gate; focused local checks are not a
replacement. The observations below are not a causal performance guarantee.

## Environment and coverage comparison

| Property            | Dependency-owned ACP PostgreSQL                                         | Stage 2                                                                          |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PostgreSQL          | `postgres:17.11-bookworm`, root Compose definition                      | Same image and definition                                                        |
| Role initialization | `scripts/postgres-init.sh`                                              | Same script                                                                      |
| Test database       | `antnest_agent_acp_test`, owned by `antnest_agent_acp`                  | `stage2_acp_test`, same owner                                                    |
| Permissions         | Service login, not administrator; PUBLIC CONNECT revoked                | Same service login; created database retains default CONNECT privilege           |
| Migrations          | Production `migrate()` from the full PostgreSQL suite                   | Same migration fixture and implementation                                        |
| Other workloads     | Dependencies only                                                       | Live authenticated service stack                                                 |
| Reset scope         | Destructive tests stay serial against their private database            | Serial migration fixture against its separate database                           |
| Cleanup             | Runner-owned isolated Compose project and volumes removed and inspected | Test database dropped; existing independent Runtime and Compose cleanup retained |

The two environments are not interchangeable: stage 2 must still prove its live
deployment and recovery contracts. Its duplicate full ACP component invocation is
replaced only by `migrate.postgres.test.ts`, including an explicit check that the
ACP database owner is not superuser, creator of roles/databases, replication role,
or RLS-bypass role, and that migrations create tables as that owner.

| Coverage                                                                                                                | Blocking owner after this batch                           |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Complete ACP PostgreSQL suite, including authorization, persistence, ownership/fencing, recovery and resource contracts | `agent-acp-postgres`                                      |
| ACP v1 SDK audit                                                                                                        | Existing separate audit command in `agent-acp-postgres`   |
| Role, migration history, backfill and newer-journal rejection in the deployed database environment                      | Stage 2 focused migration fixture                         |
| Authenticated first Prompt, boundary flow and real service deployment                                                   | Existing stage 2 boundary flow, unchanged                 |
| Creation/lifecycle worker replacement and resumption after business commit before acknowledgement                       | Existing three stage 2 Temporal recovery tests, unchanged |
| Runtime resources, database disposal and Compose cleanup                                                                | Existing independent cleanup checks, unchanged            |

Stage 2 declares `agent-acp-postgres` as required coverage. Both path selection and
explicit `--only c-stage2` expand that requirement, so narrowing the nested command
cannot silently remove the full component gate from a candidate. An unavailable
required suite fails selection rather than being silently skipped.

## Service-owned shards and isolation

Egress, Runtime Controller, Identity, Agent Controller and Agent ACP have separate
Tier A shards. Each selected suite remains assigned exactly once, and the existing
aggregate gate still rejects failed, cancelled, unexpectedly skipped, missing or
incomplete selected evidence. The historical `a-postgres` / `PostgreSQL components`
check identity is retained for ACP and its audit; its workload is now narrower, so
historical durations under that name are **not** like-for-like suite comparisons.

Each GitHub matrix job has its own runner and the existing dependency wrapper
creates a unique Compose project, ephemeral host ports, service-owned test
databases and independent teardown. No tests gain parallel access to the same
schema. Vitest still uses one worker, and commands inside each shard remain serial.
Per-service setup flags no longer install Rust for an unrelated Go/Node shard.
Caches, image references, cancellation and the Tier C six-job limit are unchanged.

Splitting jobs can reduce serial waiting but can increase runner setup overhead
and total runner minutes. This is a tradeoff to measure, not a claimed saving.

## Focused feedback and full regression

```sh
node --test --test-concurrency=1 tests/support/ci-changes.test.mjs tests/support/ci-admission.test.mjs tests/support/ci-shard.test.mjs tests/support/dependencies.test.mjs
node tests/support/dependencies.mjs --name ci-postgres-role -- npm --prefix services/agent-acp-service run test:postgres -- migrate.postgres.test.ts
```

Use focused contract tests while changing selection, required coverage or shard
assembly. Changes to CI infrastructure trigger complete selected remote admission;
do not call a focused run complete platform acceptance. Stage 2 changes retain
their full ACP component dependency even when selected explicitly.

## Measurement and follow-ups

The issue's historical baseline is one
[integration run](https://github.com/tf4fun/antnest-platform/actions/runs/40618894967)
at `a656ec8cca0181f7d1ff20123898dde1ad122cd4`: 44m09s wall time, with readiness,
PostgreSQL and lifecycle competing for the final completion time. The reported
793.51s nested ACP run is overlapping runner work, **not** a promised 793.51s
workflow saving. Cache/queue conditions were not controlled for this single sample.

Follow-up comparisons must retain candidate SHA, attempt, runner class, cache
conditions, sample count, first actionable failure, setup/test/finalization time,
complete required-gate wall time and summed runner minutes. Queue time that cannot
be distinguished from matrix scheduling stays unavailable, not zero. Readiness
phase observations and scheduling evaluation are below. Cross-workflow runner
cost and a controlled multi-run performance comparison remain unmeasured.

## Observed integration comparison

Both samples are successful attempt 1 runs on GitHub-hosted `ubuntu-24.04` runners
on 2026-10-28; sample size is **one per revision**, not a repair-cycle average:

- Baseline: [a656ec8](https://github.com/tf4fun/antnest-platform/commit/a656ec8cca0181f7d1ff20123898dde1ad122cd4), [run 40618894967](https://github.com/tf4fun/antnest-platform/actions/runs/40618894967).
- Integrated code: [a149b56](https://github.com/tf4fun/antnest-platform/commit/a149b56e1014db6c57442f0d7bb1522dcf69b2e6), [run 40636757543](https://github.com/tf4fun/antnest-platform/actions/runs/40636757543). All 51 PR checks passed, none failed, pending or skipped.

| Measurement                                           | Baseline | Integrated code |
| ----------------------------------------------------- | -------: | --------------: |
| Integration creation to required aggregate completion |   44m09s |          43m10s |
| Summed Integration runner time                        |  286m24s |         271m56s |
| Summed `Run suites` time                              |  238m49s |         223m37s |
| Readiness `Run suites`                                |   33m03s |          32m57s |
| Lifecycle `Run suites`                                |   22m11s |           8m36s |
| All PostgreSQL owners completed, workflow offset      |  +43m45s |         +16m41s |
| Summed PostgreSQL owner runner time                   |   36m45s |          40m00s |
| Summed PostgreSQL owner `Run suites` time             |   35m27s |          35m01s |

Wall time is 59s lower (2.23%); accumulated runner time is 14m28s lower (5.05%).
These are observed differences, **not attributable savings or billing amounts**.
Splitting PostgreSQL finishes that coverage earlier but adds 3m15s of accumulated
runner time in this sample. The old combined PostgreSQL check is compared with
all five new owners, not just the narrower ACP job bearing its old name.

Cache and queue conditions were not controlled. Existing dependency/BuildKit
caches and input-hashed image reuse stayed enabled. The baseline built 6 images
and pulled 8; the integrated run built 4 and pulled 10, additionally reusing ACP
and Agent UI images. No aggregate dependency-cache hit rate was collected. First
job start was +2s versus +112s; the latter includes 110s before job creation, not
measured runner queue time. Both jobs started 2s after their creation.

The new critical path is the image barrier at +8m53s, readiness starting at
+8m55s and finishing at +43m04s, then the required aggregate at +43m10s.
Readiness contributes 68s setup, 32m57s suite execution and 4s finalization.
Lifecycle finishes at +32m43s and PostgreSQL at +16m41s, so neither replaces
readiness as the long tail. The baseline image barrier was +6m57s.

Timing scope is Integration only: the auxiliary timing-report job is excluded
from runner totals, and separate service/CodeQL workflows are not summed into
this comparison. The source is the jobs API and the integrated run's `ci-timing`
artifact. Durations are completion minus start, offsets use workflow creation,
and missing timing is null. Successful runs have no first-actionable-failure
sample; the deliberate failing Vitest regression verifies live sanitized
feedback without downloading artifacts, rather than claiming a measured remote
failure-latency improvement.

## Readiness phase evidence

The integrated run's `evidence-c-agent-readiness` artifact reports 100 required
and 100 completed serial rounds, business passed and independent cleanup passed.
Every round records successful create, ready, first Prompt, deletion and resource
inspection/cleanup. All 100 injected publication delays are at least 2000ms
(minimum 2000.062ms); final cleanup is 815ms.

| Per-round observation         |  Median |     p95 |
| ----------------------------- | ------: | ------: |
| Whole host round              | 19.967s | 20.257s |
| Create                        |  1.099s |  1.111s |
| ACK/ready wait                |  9.122s | 10.232s |
| First Prompt                  |  0.078s |  0.098s |
| Delete request and completion |  4.364s |  4.384s |
| Resource cleanup              |  2.837s |  4.700s |
| Intentional publication delay |  2.001s |  2.002s |
| Client command overhead       |  0.806s |  0.832s |

p95 is nearest-rank, the 95th sorted observation of 100. Publication delay and
polling overlap the outer phases: do not add them together. Ready polling sleep
has median 8.178s, delete polling sleep 4.110s, and host unattributed time 0.032s.
Polling sleep is waiting, not proof of avoidable harness overhead; client RPC
duration is not service CPU time. These observations do not identify a service
root cause or justify weakening the serial scenario or two-second delay.

## Scheduling decision and remaining risks

At measured revision `a149b56`, Tier C retained six jobs and its original ordering. A fixed-duration
baseline simulation gave 37m01s for the original order versus 35m08s longest-first,
but it retained the duplicate lifecycle component work and ignored contention.
For the integrated sample both orders finish at 34m09s, already bounded by the
first-wave readiness job. This is an evaluation, not an executed optimization;
there is no measured basis to claim a gain from reordering this candidate.

At that revision the image matrix was a global dependency barrier. Readiness's own
image dependencies finish at +2m54s versus the global +8m53s: a 5m59s eligibility
gap, **not measured savings**. Service image workflows and Integration both build
images; existing input-hashed reuse is retained, but no new cross-workflow reuse
is introduced without verified build inputs and candidate provenance. A separate
dependency-aware scheduling batch is the next useful experiment. A proposed
target, derived from this gap and the 44m09s baseline, is a matched-cache median
gate of at most 40 minutes across at least three complete runs, without exceeding
baseline 286m24s accumulated runner time or changing admission. This is a testable
target, not a forecast or a result of this batch.

The earlier [ACP automatic-recovery failure](https://github.com/tf4fun/antnest-platform/actions/runs/40634533649/job/122640866327)
was a business assertion in `v2-inflight`, not a Trace warning. Saved recovery
metadata passes its existing assertion helper, but that does not localize the
client failure. The integrated candidate passes the scenario without changed
business assertions. The original cause remains unknown; it is not declared
fixed or dismissed as flaky. Opt-in bounded source locations now improve a
recurrence's public feedback while keeping raw assertions and inventories private.

## Execution-speed priority follow-up

The next candidate changes scheduling, not test content. The measured critical
path, `c-agent-readiness`, now occupies a dedicated one-slot Tier C matrix that
depends only on Select suites and the images that shard actually needs. Other
Tier C shards retain the complete image barrier and five slots when priority work
is selected, or six slots when it is not. Total Tier C concurrency remains at most
six, including during partial selections. The other shards retain their order.

`workflowPlan` partitions selected shards and required image builds without
duplication. Cached release images retain their input-hashed references; missing
images and local-only fixtures retain the same builds, publication policy and
run-local artifacts. Both image matrices share the same build steps. The required
aggregate still rejects failed, cancelled, missing or unexpectedly skipped work
in either image group or either Tier C group. Timing attribution follows each
group's actual dependency barrier.

Using only the frozen `a149b56` durations, a one-plus-five-slot simulation puts
priority completion at +37m03s and other Tier C completion at +34m52s. That model
ignores contention, queueing and cache drift: it is not an achieved saving. The
new candidate requires its own remote measurement. Coverage, serial readiness
rounds, two-second publication delay, business deadlines and independent cleanup
are unchanged.

Defect investigation is deliberately outside this speed batch. The separate
[Identity PostgreSQL failure](https://github.com/tf4fun/antnest-platform/issues/355)
and [ACP recovery assertion](https://github.com/tf4fun/antnest-platform/issues/356)
retain their evidence and unknown causes. No test is disabled or admitted because
it has a tracking issue; failed or superseded runs are not successful performance
samples. Uncommitted Go diagnostic follow-up work was deferred rather than added
to this scheduling change.
