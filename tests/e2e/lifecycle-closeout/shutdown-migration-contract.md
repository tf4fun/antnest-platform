# Normal shutdown and stream contract

This document defines what the whole-platform shutdown profile
(`make e2e-lifecycle-shutdown`) must prove. Production services and SDKs are
unchanged, and SIGKILL, clock and export interval tuning are not used.

## Setup

The profile reuses the Foundation setup, stable Provider and Model IDs, the
returned Template revision, an immutable Runtime image, exact lifecycle replay
and the twelve-service isolation checks. It holds three live streams, each of
which must receive valid initial data:

- an administrator lifecycle event watch;
- an owner ACP execution-state watch;
- an initialized ACP v1 connection with one persisted empty Session.

Execution state is owned by ACP and contains `agent_id`, `availability`,
`access_allowed`, `configuration_revision`, `active_session_id` and
`unavailable_reason`. There is no aggregate `agent_revision` and no Controller
workspace-state watch. Watch clients use the actual Gateway response Trace ID
and never invent unexported parent spans.

## Shutdown and restart

- Eight application services are stopped with ordinary SIGTERM while the streams
  are still open. Remote closure and ACP close code 1001 are verified without
  client-triggered cancellation.
- Temporal then stops before PostgreSQL. All ten stopped containers must exit
  zero without OOM, daemon error or replacement. Jaeger stays up through final
  export.
- The same PostgreSQL, Temporal and application containers restart in dependency
  order, with no rebuild, image pull, schema reset or database edits.
- The dynamically managed Runtime keeps its container, process, image, mounts,
  execution identity, workspace bytes and configuration.
- The same cookies work. The same Session loads, and its empty metadata and
  history, the event journal and the initial watch state are compared. Public
  audits and model status stay empty before and after maintenance.

## Trace rules

Both ACP requests and both watch paths are traced; the state watch must own the
real ACP RPC with no Controller execution-state dependency. Create and Delete
keep the Temporal, SQL and publication and settlement checks.

The event watch uses the `console` Resolve profile and the execution-state watch
uses `workspace`. Initial admission must finish before the actual Gateway CLIENT
to Console or ACP. Every admitted revalidation validates `rpc/cache/shared`
provenance, exact CLIENT-to-Identity-SERVER receipt and its owning successful SQL,
or the finite cache budget. Shared and background sources retain their real
parent chains and archived trigger Traces. SQL is counted once per actual source
SERVER, not once per waiter. No current Identity SERVER is invented for a hit.

The observer records the first closure cause, response Trace ID, host observation
time and delivered-event count. Test close, abort and invalid input cannot prove
remote closure. Before/after inventories must show the same Gateway process
exited cleanly during the observed stop operation. The remote observation must
fall between the host's actual stop start and stop completion plus one second;
the existing host/VM span window stays at stop start minus one second through
completion plus one second. Every Gateway span in the current/source/trigger
closure, including retained CLIENTs and refresh roots, must finish before its
process exits (allowing one millisecond for Docker timestamp parsing). Retained
work can outlive its original caller; independent Identity work can also outlive
the Gateway process.

A noninitial `unavailable` decision may be a verified shutdown cancellation,
never admission. Shared waiters require `caller-cancelled` or `process-shutdown`
and either an exact already-created CLIENT link or a link-free
`cancelled-before-client` snapshot. Retained source work may complete successfully
for another waiter, or be cancelled; its actual receipt is validated separately.
A direct `rpc` marker has no cancellation reason, so it requires an actual typed
cancelled CLIENT. A missing CLIENT, a successful RPC with an unclassified
unavailable caller, capacity/deadline errors, 5xx receipts or SQL failures cannot
prove shutdown cancellation. TTL zero retains synchronous CLIENT completion;
cached retained work can complete after its original caller marker.
Each cancelled transport error event must carry its own `cancelled` type and
stage. A send failure has no response status; an HTTP 200 cancellation occurs
during `read_response` or `close_response`. Unrelated exceptions, conflicting
error classifications and incomplete error events cannot share that exception.

Guard and state-frame checks can overlap. A marker ends before its result reaches
the guard, so marker completion is not an observed cancellation anchor and does
not order concurrent checks. Each decision must independently satisfy the watch
root, source and shutdown evidence. No additional forwarding CLIENT is accepted.
These idle-stream traces do not substitute for controlled evidence of the
production guard's cancellation/output timing.

Stream cancellation during maintenance is recognized only on the exact watch
path, with HTTP 200, spans completed within the observed stop window and a
matching error classification:

- Gateway `handler_aborted`, or the direct Gateway client `cancelled`;
- the Console event watch and its direct Controller client `cancelled`;
- the Controller event watch `canceled` with `request_failed`;
- the ACP execution-state watch `stream_interrupted`.

Conflicting error-event codes, wrong routes, services or methods, unowned clients
and other errors are rejected. This classification does not change service error
reporting or turn strict errors into passes. Missing parents and capture or
privacy defects fail topology. Warnings, errors, spans and timestamps are kept
unchanged, independent Traces are still collected after failures, and business
and topology results are reported separately from strict status.

Collection requires three identical full current/source/trigger snapshots;
late errors and warnings reset convergence even when span IDs are unchanged.
Whole-closure diagnostics remain strict failures. Only precisely classified
errors in the current watch contribute to `cancellation_error_spans`; source and
trigger errors cannot inherit that classification. Cancelling collection joins
the active request and bypasses neither the owning inspector nor source archives.

## Cleanup and verification

A normal Delete removes the test Agent's resources, and cleanup removes only
test-owned resources. Negative tests come first; local stream and protocol
components and Docker checks run serially.
