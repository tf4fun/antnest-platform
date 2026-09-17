# RPC response-loss revalidation

Date: 2026-09-17. Candidate: `fd0867c` plus the historical-asset fixture migrations
in the working tree. This is a fixture-only integration batch. No production
service implementation, schema, SDK version or Runtime binary was changed.

Later same-day follow-up: the [Controller-owned tracing fix](controller-publication-trace-revalidation.md)
closed the background acknowledgement SQL gap on an independent candidate.
Its 28 scoped integration traces include both actual UPDATEs. The original
observations below retain their candidate and date; strict warnings/probe errors
remain failures on the newer candidate as well.

## Current recovery boundary

The old profile called retired Controller `acquire-run` and `finish-run` APIs.
Current ACP owns Run admission and durable completion. Controller now sends
execution snapshots and requests lifecycle settlement from ACP. The replacement
therefore tests actual `apply-execution-snapshot` and `settle-agent` responses;
it does not simulate removed admission tickets or manufacture an ACP restart.

| Historical obligation | Current evidence or remaining owner |
| --- | --- |
| Upstream success happened before acknowledgement loss | A private proxy reads and validates the entire real ACP HTTP 200 before withholding all downstream response bytes; receipts preserve scope and canonical hashes |
| Retry cannot change accepted semantics | Publication retry preserves the configuration request/response; settlement retry preserves Agent, operation, minimum revision, mode, absolute deadline and settled result |
| No premature local confirmation | Public synchronization remains behind while publication is held; Rebuild remains in drain with its original Runtime while settlement is held |
| No duplicate physical effect or history mutation | Real Bash append/read, immutable completed audit/execution snapshot/events, two official SDK reconnect replays and unchanged Provider request counts in every case |
| Closed execution cannot accept a new intent | Both SDK versions receive exact `-32020 / agent_unavailable / retryable=false`; no notification, Run intent or Provider call is added |
| Recovery after ACP loses a database commit receipt | Still pending in the ACP persistence-fault batch; lost Controller acknowledgements do not exercise this window |
| Cold credential rehydration after process restart | Separate [session-cost restart evidence](session-cost-revalidation.md); ACP stays running in this profile |

## Scoped deployment evidence

Both SDK versions execute four fault cases in one fresh disposable stack:

- Eight successful Runs, eight actual Bash calls, 16 Provider requests, eight
  reconnect replays and two closed-Agent rejections.
- Two Model edits are already used by ACP while Controller's acknowledgement
  is withheld. Real delivered retries catch up persisted synchronization.
- Two Rebuilds wait for successful delivered settlement before replacement.
  One deterministic Runtime operation journal is completed for each Create/Rebuild/Delete
  command; workspace markers survive both replacements.
- ACP retains the same container, start time and restart count and stays
  healthy. Agent deletion leaves no owned Runtime container or volume.
- Twenty-eight independently correlated traces cover two normal lifecycle
  commands, four fault/control traces and 22 Session requests. Exact request
  IDs and real propagated CLIENT span IDs are used; no connection-wide trace
  substitutes for an individual SDK request.

The proxy and client have no Docker socket or database access. Public Console
audits establish persistent Run/history state; Runtime inspection is read-only.
Raw fixture bodies and credentials are not captured. Trace content capture stays
disabled, and the oracle checks credential/privacy boundaries.

## Strict evidence limits

This batch is not a full strict E2E pass. The command retains a nonzero exit
status. Timing warnings, Docker absence-probe ERROR spans and the new missing
background publication acknowledgement SQL are reported separately. Expected
injected HTTP `send` errors are tied to the exact dropped receipt; only the
matching failed Temporal drain attempt is accepted as its consequence.
Unrelated errors still fail the oracle.

`controller_publication_ack_sql_missing` is a new Controller observability
follow-up, not part of `OBS-ACP-CLOCK`. The publication worker restores only a
span context through `trace.ContextWithSpanContext`; its database tracer and
transaction instrumentation require a recording parent. The repository's
`TestRepositoryDriverObservationBatchAndNoParent` explicitly tests suppression
of nonrecording/background SQL. As a result the HTTP retry and real ACP driver
write/read are visible, but Controller's successful `RecordExecutionApplied`
UPDATE is not. Public persisted acknowledgement readback passes; complete
write-side Trace evidence does not. A separate Controller-owned batch must add
the appropriate publication tracing and local gates, followed by this integration
rerun. It must not enable unbounded background SQL tracing indiscriminately.

ACP database commit-receipt loss, interrupted-Run recovery and unknown Tool
effects remain the next persistence-fault migration scope. This report does not
claim that those historical obligations, browser workflows or operational
closeout have passed.

## Reproduction and artifacts

Use [the current fixture](../scripts/rpc-response-loss/README.md) and its
[contract](../scripts/rpc-response-loss/contract.md):

```sh
make test-rpc-response-loss-fixtures
make e2e-rpc-response-loss
```

Local fixture/shared gates are recorded in
`.cache/legacy-acceptance-20260917/rpc-gates-final.log`.
Private deployed traces and exact correlation inputs are under
`.cache/rpc-response-loss/<project>/rpc-traces/`. Process, deletion and deployment
metrics are in `rpc-docker-*.log`; cleanup and the retained 12-container baseline
are in `rpc-cleanup.json` and `rpc-retained-before.json` in the same acceptance
cache. These logs/traces are local evidence, not committed source assets.

The first attempt stopped at an obsolete `tool_result` audit assertion before
recovery, and its client cleanup assumed asynchronous SDK close. Both fixture
errors were corrected to the current `tool_call` contract and synchronous-or-
asynchronous close handling. The second attempt completed all business cases
and retained every raw trace, exposing the publication SQL gap and the actual
transport error stage `send`. The final oracle records that gap as a strict
failure rather than masking it as a clock warning.

## Final verification and retirement

The final deployed project was `antnest-stage3-e2e-96710`. All four business
cases and 28 scoped topology/privacy checks passed. The strict gate failed on
16 traces: 11 traces have 2,683 warning entries, four Docker absence-probe ERROR
spans remain errors, and two publication traces have the missing acknowledgement
SQL gap. Categories can overlap. Six injected/consequent error spans match four
dropped HTTP responses and two failed drain attempts. The warning count includes
repeated Jaeger warning entries, not 2,683 independent faults. One Delete warning
reports a missing parent that is present in the final collected trace; it remains
a warning and a strict failure. No full timing or persistence-trace pass is claimed.

All three projects (`95151`, `95532`, `96710`, with the same Stage 3 prefix) have
zero owned containers, volumes or networks and no remaining verification child
processes. The retained 12-container development environment has unchanged IDs,
images and health. No retained data, rollback image or private backup was removed.

The 61 local fixture/shared checks passed before final deployment. After the
consumer search and cleanup, only the ten obsolete RPC-specific source/test/
Compose files were removed. The dated [historical record](../scripts/acp-closeout/rpc-loss.md)
remains with a current-entry redirect. Shared closeout model, connection, replay,
wait, checkpoint, network, Docker and unknown-effect helpers remain for their
unmigrated consumers. Their fixture tests do not constitute current deployment
acceptance.
The remaining closeout helpers and parent cleanup tests passed all 34 checks
after retirement (`rpc-retirement-gates.log`); this includes the three cleanup
cases already present in the predeployment shared gate.
