# Agent ACP Service Data Retention and Operator Erasure

This document is the semantics half of
[`data-retention.json`](data-retention.json), version 1, the shared contract for
issue #55. It codifies how Agent ACP Service retains and purges deleted Session
content and how an operator requests scoped erasure. The contract is planned
only: publishing it activates no route, worker, migration or CLI. The owning
`agent-acp-service` implementation batch activates the behavior; consumers and
the explicit integration batch follow separately.

## Configuration

| Setting                   | Environment variable                    | Default | Bounds                       |
| ------------------------- | --------------------------------------- | ------- | ---------------------------- |
| Deleted Session retention | `ANTNEST_ACP_DELETED_SESSION_RETENTION` | `30d`   | `0` disables automated purge |
| Sessions per purge batch  | `ANTNEST_ACP_PURGE_BATCH`               | `500`   | 1–500                        |
| Purge worker interval     | `ANTNEST_ACP_PURGE_INTERVAL`            | `60s`   | positive duration            |

Retention is measured by the durable `deleted_at` timestamp recorded when a
Session's state becomes `deleted`. Rows already deleted before the column exists
are backfilled conservatively at migration time so they cannot be purged earlier
than an operator would expect. A Session is eligible only under a strict
`deleted_at < cutoff` comparison. A retention of `0` disables the automated
worker; operator erasure through the CLI remains available.

## Automated purge scope

The automated purge removes only deleted Sessions and their Session-owned
content — including derived learning records inside the selected scope. It never
removes active Sessions, closed Sessions that are not deleted, or the Run
history of Sessions that are not deleted. These restrictions bind the automated
worker only; the operator CLI below may erase selected Sessions in any state.

Receipt semantics for retained Sessions are unchanged. A fully purged Session
still resolves to `session_not_found` after ordinary authorization, identical
to a Session that never existed. Issue #19's active-history compaction and
expired receipt outcomes are deliberately not activated by this contract.

## Purge worker

The worker deletes at most `ANTNEST_ACP_PURGE_BATCH` Sessions per batch and each
batch is transactional and rollback-safe. It runs under the existing legacy
worker lock or, in peer mode, the immutable per-Agent generation fence; the
fence is checked live at commit so a fenced-out member commits nothing.

The worker never purges Sessions blocked by nonterminal, unresolved or
non-quiescent Runs, unreleased temporary Skills, running Learning tasks, or
unsettled maintenance or protection. Blocked work is skipped and reported, never
counted as cleanup success, and bounded scans continue past blocked rows
without starvation.

## Operator erasure CLI

`node dist/purge.js` is offline maintenance. It takes exactly one scope
selector:

- `--organization <id>` — all Session principals of the organization
- `--user <id>` — one principal across ACP organizations
- `--session <id>` — one Session

The scope applies only to Session content and its derived learning records. It
never performs arbitrary external Identity, Controller, Runtime or Registry
deletion.

Explicit confirmed erasure is not bound by the automated retention scope: it
includes active, closed and deleted Sessions without grace-period delay. The
same quiescence and cleanup guards still apply — Sessions blocked by the work
listed under the purge worker are skipped and reported, and there is no force
bypass.

The CLI takes the exclusive existing ACP worker lock and refuses to run against
a live ACP, including peer or shared lock holders. `--dry-run` requires the same
lock and only reports bounded-batch counts. Real deletion requires `--confirm`,
which is rejected together with `--dry-run`. The CLI does not start the service
or listeners and does not run migrations automatically. A hard failure exits
nonzero; when work is blocked the blocker counts are reported with a nonzero
incomplete result, and a rerun resumes the remaining work.

## Audit

Every committed batch emits one `acp_content_purge_batch` audit event. The
payload is counts only — no content, no Session, Run, user or organization IDs,
and no SQL.

## Published Skill provenance

A published managed Skill artifact stays readable and re-publishable after its
source Session is purged. Its provenance is explicitly tombstoned, while the
evidence bodies, request bodies and unpublished candidates derived from the
Session are removed.

## Retained records and table exceptions

Purging never reduces or zeroes retained budget or accounting rows, including
unknown charges. The intentional metadata and derived-record exceptions are:

| Table                            | Disposition                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `model_budget_history`           | accounting ledger; retained, never reduced                                     |
| `model_budget_reservations`      | accounting reservations; retained, never reduced                               |
| `model_budget_baseline_attempts` | accounting baseline evidence; retained, never reduced                          |
| `model_budget_baseline_receipts` | accounting baseline receipts; retained, never reduced                          |
| `organization_spend`             | accounting totals including unknown charges; retained, never reduced or zeroed |
| `run_usage`                      | per-Run usage accounting; retained, never reduced                              |
| `learning_managed_skills`        | published managed Skill artifacts; retained with tombstoned provenance         |

Table documentation in the owning service identifies these intentional
exceptions; Session-owned content and derived learning records outside this list
follow the purge scope above.

## Boundaries

Backups, WAL archives, replicas and logs, and the distribution of published
Skill artifacts, each have a separate operator lifecycle outside this contract.
This contract does not claim comprehensive GDPR erasure.
