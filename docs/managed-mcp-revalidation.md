# Managed MCP Asset Revalidation

Date: 2026-09-17. Fixture-only integration batch after base Stage 3 migration.
No production service code, SDK dependency or retained deployment was changed.
The [fixture contract](../scripts/managed-mcp/contracts.md) was defined before
implementation; new setup, drain and Trace behavior was developed test-first.

## Result and boundary

Both installed SDK versions passed the business and Trace topology/privacy
checks. Strict Trace remains **failed** on both versions; neither Make target
is recorded as an overall pass. Existing clock-maintenance deferral is preserved,
and Docker absence-probe errors have not been waived.

| Evidence | ACP v1 | ACP v2 |
| --- | ---: | ---: |
| Completed Runs | 6 | 6 |
| Validated Provider HTTP requests | 15 | 15 |
| Actual Runtime Tool calls | 9 | 9 |
| Managed stdio calls, including controlled failure | 6 | 6 |
| Held responses with closed publication and unchanged Runtime | 2 | 2 |
| Create/Rebuild/Delete Runtime operation records | 3 | 3 |
| Lifecycle Trace topologies | 3 | 3 |
| Independent Session request Trace topologies | 11 | 11 |
| Strict warning traces | 6 | 6 |
| Returned warning entries, including repeated Jaeger annotations | 786 | 1,536 |
| Lifecycle Docker absence-probe ERROR spans | 3 | 3 |
| Deliberate Tool-error spans, scoped to alpha fail | 5 | 5 |

All 63 local fixture/shared-boundary tests passed serially. The test-image build
also passed Runtime formatting, Clippy, 143 library tests, one binary test and
the Rust Managed child handshake/catalog test. Shell syntax, Node syntax and
format checks passed. These checks do not make the strict Docker gate green.

## Current replacement

| Retired assumption | Current evidence |
| --- | --- |
| Internal Model-profile creation and revision-pinned Template | Console Provider connections, stable Model ID, immutable returned Template revision and immutable test image |
| Controller admission ID on model spans | One ACP Run per successful prompt; actual Provider HTTP CLIENT under model.complete; captured configuration/spec/execution/Runtime identity |
| Drain worker freshness inferred from independent clocks | Two explicit Provider barriers; exact Controller operation remains in drain, public ACP state reports busy/agent_unavailable, matching durable Run remains running, Runtime identity unchanged |
| A completed Tool frees admission | Second barrier holds the final answer after both alpha calls; durable Run and busy Session still prevent replacement |
| agent_rebuilding rejection or stale connection admission failure | Another Session gets exact -32020/agent_busy/retryable=false, no notifications, no Run intent or execution; existing connection uses beta after publication |
| Failed stale intent changes replay stop reason | Six successful Runs retain inputs, terminal Tool IDs/results and ordered answers; v2 replay ends idle/end_turn |
| Connection-wide trace stands in for requests | Actual SDK JSON-RPC IDs plus connection links select 11 distinct request traces; replay/new/busy probes have no model/Runtime execution |
| Legacy parent supplies cookies/catalog | Independent disposable profile logs in and seeds current product APIs itself, using bounded clients and owned cleanup |

The real child counter proves alpha reuse across Runs and during drain, then
beta starts at one after replacement. UID/GID are 1000; explicit child environment
is present while Runtime supervisor/launcher environment is absent. Workspace
guidance refreshes without Rebuild, Skill summaries/locators are available, and
full Skill bodies are excluded from initial context. Rebuild preserves workspace
and history. Both version-specific completion contracts and deletion reclamation
passed. The controlled ordinary Tool failure is visible, followed by successful
execution; no unknown-effect/crash-recovery claim is made.

Lifecycle traces include the actual Gateway response Trace ID, Console and
Controller HTTP ancestry, official Temporal workflow/activities, committed driver
writes, current ACP publication/settlement and exact Runtime command IDs. Session
traces require per-Run information/catalog preparation, real stdio descendants,
no management dependency inside execution and actual PostgreSQL Run closure.
The final validator was also run offline against all 28 saved traces after its
stdio duplicate/error checks were tightened. Original live runs checked actual
cookie secrets; offline revalidation additionally checked the fixture canaries.

## Strict failures

Both final runs return nonzero. Warning traces include clock adjustment warnings
and two delete-trace parent-missing annotations per version. All four referenced
parents are present in the final collected traces; topology checks still require
those parents. The persisted Jaeger warnings remain failures and are not erased
or reclassified as success. Recorded clock deltas range from -277.465 to
911.613 microseconds.

Each version has two Create and one Rebuild Docker GET-404 absence-probe ERROR
spans. They have matching Agent/operation identity and successful allocation/start
follow-ups, allowing topology diagnosis, while strict Trace still fails. The
separate alpha fail Tool has exactly scoped mcp_tool_error/managed_tool_error
spans in ACP and Runtime; other errors, including transport failures or unknown
Tool effects under that dispatch, are rejected by the oracle.

This batch does not force host clock synchronization, alter SDK timestamps,
modify production telemetry or claim full acceptance of historical closeout
profiles.

## Cleanup and retained assets

Final v1 project: `antnest-stage3-e2e-91405`.
Final v2 project: `antnest-stage3-e2e-92403`.
Earlier fixture-debug projects: `antnest-stage3-e2e-90252` and
`antnest-stage3-e2e-90684` (old busy error mapping, then missing returned Session
ID in the new-session trace expectation). These were fixture failures, not
passing deployment evidence.

All four projects have zero remaining owned containers, volumes and networks,
checked by both Compose/Runtime ownership labels and names. No verification child
process remains. Agent deletion independently verified zero Runtime containers
and volumes before project teardown. All 12 retained development containers
kept their IDs, images, health and running state. Rollback images and private
backups were preserved.

The test-only image remains
`sha256:59c0cc5ece8650f8fcbf5134ff42b663ffda6cbd7b1c59d2ae65ec0f6bdc3ed0`;
its rebuilt fixture layer matched the existing binary. Production Runtime stayed
`sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909`.

Private local evidence is under `.cache/legacy-acceptance-20260917/`:
`managed-gates-final.log`, `managed-build.log`, `managed-image.log`,
`managed-v1-docker-3.log`, `managed-v2-docker-1.log`,
`managed-final-traces.json` and `managed-cleanup.json`.
Raw traces/expectations are under `.cache/managed-mcp/<project>/managed-traces/`.

Removed only the Managed client's obsolete pinned/admission/stale-connection and
clock-based drain validators and their obsolete tests. `captureRuntime` remains
for its other consumer, and the shared legacy `trace.mjs` oracle remains for
unmigrated closeout/lifecycle/workspace consumers. The 2026-09-10 report remains
historical, not current evidence. The subsequent [RPC batch](rpc-response-loss-revalidation.md)
migrated publication/settlement acknowledgement loss and recorded ACP persistence
faults separately as pending. Retained/extended Stage 3 and Identity fault/OIDC
branches remain in the inventory.
