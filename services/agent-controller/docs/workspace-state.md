# Workspace State

Agent Controller owns current Agent admission and lifecycle state. A browser
must not infer availability from its own ACP request promise. Edge Gateway reads
or subscribes using its authenticated principal. These are internal endpoints.

## Contract

- `GET /internal/workspace/agents/{agent_id}/state`
- `GET /internal/workspace/agents/{agent_id}/state/watch`

Both require exactly one nonempty `organization_id` and `principal_id` query
value. Unknown or inaccessible Agents return the same 404 before streaming.
The payload contains only `agent_id`, `availability` (`ready`, `busy`, `offline`),
`access_allowed`, `agent_revision`, and nullable `active_session_id`.

`agent_revision` is the Agent aggregate revision, not a stream cursor or a Run
sequence. It changes on lifecycle/configuration transitions; consumers compare
the entire state, including active Session, not just this revision. Session IDs
are returned only for active admissions owned by the requesting principal.
An unresolved terminal effect blocks admission but is not a running Session.
An active lifecycle operation or disabled desired state closes admission even
if the previous stable lifecycle state is still `available`. Existing work can
still be identified for cancellation while an authorized lifecycle drain runs.
Admission deadline expiry never implies that a Run has stopped.

Watch emits `event: workspace_state` with a complete replacement snapshot. It
has no event ID, replay journal, or Last-Event-ID contract. The application
subscribes before reading, emits the initial snapshot, then re-reads after each
wake-up. Identical snapshots are suppressed. On lost access, an already-open
Watch emits `access_allowed: false`, `offline`, a null active Session and the
last disclosed Agent revision, then closes. No newly read metadata is disclosed.
A failed scoped read or subscription registration closes the stream, never
inventing an available state. A disconnected-but-retrying shared listener is
different: its freshness limitation is described below.
Consumers recheck access and reload ACP after binding changes; this observation
contract does not promise delivery of every intermediate lifecycle transition.

## Persistence And Wake-Ups

Existing `agents`, `agent_access_bindings`, and `run_admissions` in the private
`agent_controller` schema remain authoritative. No table or normal Run audit
event is added. A transaction-scoped PostgreSQL notification on admission insert,
state transition, or deletion shares the existing notification connection.
Rollback and idempotent replay do not announce a transition. Lifecycle and
identity events already wake this connection.

Notifications are coalescible hints, not state or delivery acknowledgements.
SQL errors are not ignored. The shared listener broadcasts after reconnect to
recover commits made during a LISTEN outage. This does not provide a bounded
freshness guarantee during an ongoing outage: Edge must bound stream/authentication
leases and clients must close actionable state on transport failure. Reconnect
starts with a fresh scoped snapshot, never a prompt replay. No polling loop,
per-browser database connection or cross-service database access is introduced.

Reads use the normal traced query Port. HTTP spans retain incoming trace context;
Watch metrics use bounded scope labels. Per-frame writes have a deadline and
cancellation releases the waiter. Packet forwarding is outside this scope.

## Delivery Boundary

This producer batch implements Agent Controller only. Edge Gateway must next
authenticate and relay this contract with bounded identity leases. Agent UI then
uses it for input availability, current-session cancellation and access changes.
ACP still owns Session history, prompt, cancellation, Tool updates and approval;
state observation is not a replacement private conversation protocol.

Acceptance covers subscribe/read races, duplicate hints, cancellation, scope
isolation, lifecycle barriers, blocked effects, commit/rollback notifications,
no normal-Run audit append, JSON/SSE contracts and trace context. Docker/browser/
Jaeger full-stack acceptance follows the consumer batches.
