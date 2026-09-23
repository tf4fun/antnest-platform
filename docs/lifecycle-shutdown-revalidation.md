# Normal shutdown and stream acceptance migration

Date: 2026-09-21. Source baseline: `866d0aa`, preserving the preceding uncommitted
network migration. This batch migrates `make e2e-lifecycle-shutdown`; production
service code and SDK versions are unchanged.

The acceptance assets are migrated, but stable shutdown acceptance remains
incomplete at this batch's conclusion: a repeated post-restart Delete timeout
required a separate readiness repair. One complete business/topology pass does
not override failed repeats. The later [Temporal readiness batch](temporal-readiness-revalidation.md)
records the candidate fix and independent repeated verification; original results
below remain unchanged.

## Current contract

The [shutdown migration contract](../tests/e2e/lifecycle-closeout/shutdown-migration-contract.md)
was defined first. The profile reuses current Foundation setup and exact
lifecycle replay with the actual Template revision, immutable Runtime image,
private Temporal, reserved infrastructure addresses and twelve-service deployment
checks. Other historical profiles remain separate consumers.

The owner state watch now validates ACP's configuration digest, availability,
access and unavailable reason, rather than the removed Controller aggregate
revision. Its Trace must contain ACP's actual POST
`/rpc/agent-acp/watch-agent-execution-state`, with no Controller or Console
execution-state dependency. Administrative lifecycle events still traverse
Gateway, Identity, Console and Controller.

The SSE fixture no longer sends a fabricated traceparent with an unexported
client parent. It captures the actual Gateway response Trace ID. Topology checks
now cover every span, missing parents, capture/privacy and errors, with separate
strict warning/error status. Precisely classified stream cancellation on the
actual watch path within the observed stop window remains visible as errors and
fails strict Trace; arbitrary dependency errors are rejected.

The scenario holds both validated watches and an initialized ACP v1 connection
with a persisted empty Session. It stops eight application services with SIGTERM
before closing any client, then Temporal and PostgreSQL. Ten exact containers
must exit zero without OOM/daemon failure. Jaeger remains available for completed
span collection. Restart starts only the existing PostgreSQL, Temporal and
application containers in dependency order; no schema jobs or resource recreation
are requested.

The dynamically managed Runtime must retain its process/container/image/mounts,
execution binding, configuration and workspace sentinel. The same cookies load
the same Session with identical empty metadata/history. New watches return the
same initial state/events, and the complete Agent event journal is unchanged.
Public Run audits and model status must remain empty. Both actual ACP requests
are traced using their real JSON-RPC IDs and connection links. Business Delete
and current Create/Delete lifecycle Trace validation complete the scenario.

## Verification

New negative tests cover current state shape, accidental Run/model execution,
unhealthy restarts, orphan spans, RPC payload capture, error-status-only failures,
raw warning/cancellation preservation and a Controller substitute for ACP state.
The real SSE component proves actual response Trace identity, initial delivery,
remote closure without reconnection and rejection of test-owned cancellation.

Initial affected local gates: 82 tests passed. The first current deployment,
`antnest-lifecycle-29242f7b`, passed the complete business scenario: ten exit-zero
stops and same-container restarts, remote SSE closures, ACP 1001, unchanged Runtime,
workspace and Session, empty execution/model activity and normal Delete. Its two
watch traces were rejected by the historical Gateway-only cancellation rule.
The original exit-1 result and raw errors remain recorded.

The actual traces contain Console `cancelled` events, Controller event-watch
`canceled` / `request_failed`, and ACP state-watch `stream_interrupted`, on the
same HTTP-200 streams during observed shutdown. All parent edges are present.
The test-first follow-up explicitly recognizes only these exact watch roles,
routes/methods, direct client ancestry, error types and the actual stop window.
Negative tests reject other dependencies, 503 responses, unrelated/detached
clients, out-of-window ends and conflicting error-event codes. No raw trace or
service implementation was changed, and all cancellation errors still fail the
strict gate. The first deployment is not retroactively marked passed.

The second deployment, `antnest-lifecycle-4e3d6e89`, passed shutdown, recovery and
the four watch/ACP request traces, but its final Delete POST failed at the HTTP
transport boundary before returning a response. Its complete profile remains
failed. No automatic mutation retry was added. Subsequent verification includes
private host HTTP error diagnostics and bounded service logs on failure; these
do not change request handling or span contents. The original underlying
transport cause was not retained by the old sanitized client error wrapper and
is not inferred from the later successful run.

The next complete deployment, `antnest-lifecycle-f575edfc`, passes business and
all six topologies. Ten containers exit zero and restart with identical IDs;
both watches close remotely, ACP closes with 1001, and the same Session loads
without a Run or model call. The Runtime process/binding, mounts, sentinel and
Agent event history are unchanged. Create/Delete and exact replay pass, and
normal Delete removes the Agent resources before teardown. The host diagnostics
contain only watch socket closure/client disposal, with no failed mutation.

The six scoped checks comprise two watch traces, two actual ACP request traces
and two lifecycle traces. Parent edges are complete. Strict exit is 2: four
traces fail, with two warning traces and seven watch cancellation error spans
retained. Besides clock-adjustment warnings, one trace retains eleven Jaeger
missing-parent warning messages whose referenced parents are all present in the
final raw span set. The final topology has zero missing parent edges; the warning
messages still fail strict validation. No error, warning, timestamp or span ID
was rewritten.

The fourth deployment, `antnest-lifecycle-fbc8d793`, again reaches post-restart
Delete after the shutdown/recovery assertions and four watch/ACP trace checks,
then fails. Host diagnostics identify a 15-second `TimeoutError`, matching the
client's bounded request timeout. At the same time, Temporal logs report
`Not enough hosts to serve the request`, a failed Ringpop bootstrap attempt and
a roughly 15-second `ExecuteMultiOperation` call. Controller records Delete as
503, and Console records `dependency_unavailable`. This supports a Temporal
post-restart readiness gap; it does not establish the underlying membership
recovery defect or retrospectively prove the second run's cause.

The Compose Temporal healthcheck only probes TCP port 7233. All ten containers
being healthy and ACP read/session recovery succeeding therefore did not prove
that Temporal could accept the next lifecycle command. The next repair batch
must define and test post-restart Temporal/Controller readiness, investigate
membership recovery, and rerun this scenario. Request timeouts, mutation retries,
service healthchecks and production code were not changed to mask this failure.

Final serial local regression: 922 tests, 917 passed, five separately gated ACP
PostgreSQL fault tests skipped, zero failures. Independent cleanup checks find
no containers, volumes or networks for any of the four projects under either
Compose or Runtime-controller ownership labels, and no verification children.
All twelve retained development containers preserve their IDs, images, mounts,
running state and health. Old acceptance assets remain retained.

## Evidence and remaining scope

Private logs and baseline snapshots are under
`artifacts/verification/lifecycle-shutdown-migration-20260921/`; deployment/raw Trace diagnostics
are under `artifacts/verification/lifecycle-shutdown/<project>/`. Ignored evidence must not be
published and is not guaranteed in a fresh clone.

This scope is idle coordinated maintenance, not SIGKILL or active-Tool crash
recovery. Health, restore, loss, interrupted-update, older Workspace and retained /
extended Stage 3 consumers remain separate migration batches. Old shared assets
are retained, and the accepted clock investigation remains deferred.
