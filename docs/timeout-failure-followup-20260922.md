# UI timeout and fixture failure follow-up

Date: 2026-09-22. Status: local gates and targeted business/topology regression
passed; strict timing diagnostics remain failed.
Candidate: `c9cb88f` plus this acceptance-only follow-up.
Production service implementations and images are unchanged. This batch addresses
the two intermittent failures recorded in the
[combined regression](final-candidate-regression-20260922.md), with separate UI
test and shared acceptance batches followed by targeted integration.

## UI initialization

The original two `Context usage` queries failed at their default one-second
deadline during the first full component run. Unchanged focused and full reruns
passed. The original log does not show whether bootstrap, SDK initialization or
history replay was still pending, so its precise scheduling cause is unproven.

Both affected tests now mount the App inside awaited asynchronous React `act`.
This flushes fixture initialization before the DOM query starts its timeout.
The query deadline and usage assertions are unchanged. No production wait,
retry or usage rendering behavior was added.

A controlled test holds the selected Session's replay response after delivering
a usage notification. It checks that loading has started, usage is not yet
published and the composer is disabled; releasing the response makes usage
visible and enables input. The pending response is released even if an early
assertion fails. With synchronous mounting this test first failed because
`session/load` had not started. It passes with awaited `act`. This demonstrates
the fixture synchronization gap, not a recreation of the original wall-clock
timeout or a proven production defect.

## Agent cleanup diagnostics

The original slash-command failure happened after all three business transports
passed. Only an outer `AggregateError` and the stale business stage survived;
subsequent unchanged deletion runs passed. Its underlying request/operation
failure cannot be reconstructed from that evidence.

Commands, Multimodal and Session cost now share cleanup that attempts every
created Agent, distinguishes delete submission from operation polling and
preserves an earlier business exception when cleanup also fails. Failures remain
nonzero. Cost still closes its observer before Agent deletion. Successful
business, isolation, replay and Trace assertions are unchanged.

The [shared diagnostic contract](../tests/support/verification/README.md#safe-fixture-failure-diagnostics)
retains allowed error types/codes, request phase, HTTP status, timeout, Agent
index and the last known lifecycle kind/phase/state. Aggregates have depth and
child-count limits plus a truncation marker. It excludes free-form messages,
stack text, bodies, headers, arbitrary causes and Controller `error_detail`.
Gateway errors still have no raw `cause`; transport classification is copied
before the original exception is discarded. Unknown values are omitted.

The existing 15-second HTTP limit and 120-second operation wait remain. There is
no retry of a failed deletion request. Contract tests cover partial cleanup,
business plus cleanup failure, invalid responses, polling timeout, nested and
cyclic aggregates, request/body timeouts and transport errors. A local HTTP
component test returns `running/network_release`, then HTTP 503, and verifies
that the last state is retained while the next Agent is still deleted. The
response-body timeout test first failed on missing HTTP status, then passed
after that safe field was added.

## Verification

Private command logs, red/green evidence, serial queues, immutable image IDs and
resource comparisons are under `artifacts/verification/timeout-failure-followup-20260922/`.
Verification commands run serially.

| Gate | Result |
| --- | --- |
| Focused diagnostic/unit/local HTTP tests | 58 passed |
| Full shared fixture suite | 1,242 passed, five opt-in PostgreSQL skips, zero failures |
| Agent UI unit/component suite | 69 unit and 128 component cases passed |
| `make fmt-check` | Passed |
| `make node-lint` | Passed, including frontend type checks |

The five unchanged PostgreSQL skips retain their separately enabled evidence in
the preceding combined regression; they are not represented as fresh passes in
this batch. UI production behavior is unchanged, so this is component evidence,
not a new browser deployment claim.

| Docker profile | Business and cleanup | Trace topology/privacy checks | Strict failed checks | Make exit |
| --- | --- | --- | --- | --- |
| Slash commands | Three transports and Agent deletion passed | 40 | 16 | 2 |
| Multimodal | Three transports and Agent deletion passed | 48 | 19 | 2 |
| Session cost, complete rerun | 52 model requests, one ACP restart, nine Session restores and Agent deletion passed | 137 request + 19 pricing | 96 | 2 |

All 244 topology/privacy checks pass. Strict failures retain the inspected clock
warning category; Multimodal also retains three negative model-finish intervals
in its intentional local-failure scenarios. These timing results are not waived
or relabeled as passes. The original Agent deletion failure did not recur.
The complete Session cost rerun took 411.64 seconds including setup and cleanup.

The first Session cost invocation lost its outer exit-code recorder when the
user interrupted the tool turn. Its owned process group continued, then finished
business/Trace checks and normal cleanup. The coordinator verified that those
processes ended and the resource inventory returned to baseline before rerunning
only this profile. The interrupted invocation remains diagnostic evidence, not
the final complete command record.

The twelve retained development containers were already stopped at this batch's
baseline; their retained Docker health fields are not evidence of running
service health. The environment comparison preserves that original state. Its
first check found only reordered mount entries; comparing mounts by destination
confirmed no mount change. It also removed a copied, inapplicable assumption
that retained containers must already be running. Neither correction starts,
stops or changes any retained container.

Final inventory is unchanged at 12 containers, 271 volumes and 14 networks.
All twelve retained container identities, images, start times, restart counts,
mounts, networks and stopped states match the original baseline; all ten pinned
image IDs match. No owned verification process remains. No service deployment
or image rebuild was performed.

This follow-up does not reopen previously inspected strict timing diagnostics,
F07 or separately opted-in crash recovery. The historical failures remain in
their original report. Passing reruns alone cannot establish the original
deletion root cause or guarantee that the original UI timeout will never recur.
