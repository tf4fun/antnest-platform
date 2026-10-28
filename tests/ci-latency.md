# CI latency and retained PostgreSQL coverage

This is the PostgreSQL ownership batch for [#350](https://github.com/tf4fun/antnest-platform/issues/350).
It removes duplicate component execution, not business acceptance. Complete remote
CI for the exact candidate remains the merge gate; focused local checks are not a
replacement. No end-to-end latency improvement is claimed before remote measurements.

## Environment and coverage comparison

| Property | Dependency-owned ACP PostgreSQL | Stage 2 |
| --- | --- | --- |
| PostgreSQL | `postgres:17.11-bookworm`, root Compose definition | Same image and definition |
| Role initialization | `scripts/postgres-init.sh` | Same script |
| Test database | `antnest_agent_acp_test`, owned by `antnest_agent_acp` | `stage2_acp_test`, same owner |
| Permissions | Service login, not administrator; PUBLIC CONNECT revoked | Same service login; created database retains default CONNECT privilege |
| Migrations | Production `migrate()` from the full PostgreSQL suite | Same migration fixture and implementation |
| Other workloads | Dependencies only | Live authenticated service stack |
| Reset scope | Destructive tests stay serial against their private database | Serial migration fixture against its separate database |
| Cleanup | Runner-owned isolated Compose project and volumes removed and inspected | Test database dropped; existing independent Runtime and Compose cleanup retained |

The two environments are not interchangeable: stage 2 must still prove its live
deployment and recovery contracts. Its duplicate full ACP component invocation is
replaced only by `migrate.postgres.test.ts`, including an explicit check that the
ACP database owner is not superuser, creator of roles/databases, replication role,
or RLS-bypass role, and that migrations create tables as that owner.

| Coverage | Blocking owner after this batch |
| --- | --- |
| Complete ACP PostgreSQL suite, including authorization, persistence, ownership/fencing, recovery and resource contracts | `agent-acp-postgres` |
| ACP v1 SDK audit | Existing separate audit command in `agent-acp-postgres` |
| Role, migration history, backfill and newer-journal rejection in the deployed database environment | Stage 2 focused migration fixture |
| Authenticated first Prompt, boundary flow and real service deployment | Existing stage 2 boundary flow, unchanged |
| Creation/lifecycle worker replacement and resumption after business commit before acknowledgement | Existing three stage 2 Temporal recovery tests, unchanged |
| Runtime resources, database disposal and Compose cleanup | Existing independent cleanup checks, unchanged |

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
at `a656ec8cca0181f7d1ff20123898dde1ad122cd`: 44m09s wall time, with readiness,
PostgreSQL and lifecycle competing for the final completion time. The reported
793.51s nested ACP run is overlapping runner work, **not** a promised 793.51s
workflow saving. Cache/queue conditions were not controlled for this single sample.

Follow-up comparisons must retain candidate SHA, attempt, runner class, cache
conditions, sample count, first actionable failure, setup/test/finalization time,
complete required-gate wall time and summed runner minutes. Queue time that cannot
be distinguished from matrix scheduling stays unavailable, not zero. Readiness
phase observations, duration-aware Tier C ordering, image dependency scheduling
and cross-workflow required-gate timing remain separate measured work.
