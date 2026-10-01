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

## Cleanup and verification

A normal Delete removes the test Agent's resources, and cleanup removes only
test-owned resources. Negative tests come first; local stream and protocol
components and Docker checks run serially.
