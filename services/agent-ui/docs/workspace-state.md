# Workspace State Observation

This document describes how Agent UI obtains Agent management state and ACP
execution state, and how the browser recovers when observation is lost.

## Contract And Ownership

The chooser obtains the full authorized Agent list from the Node Bridge at
`GET /api/app/workspace/v1/bootstrap`. Node reads it from Agent Controller's
principal-scoped workspace directory (`ANTNEST_AGENT_CONTROLLER_URL`) using the
Gateway workload identity and Identity-signed caller context. Each entry carries Controller
lifecycle/runtime state and, when created, activation state. The browser
stores these as management state, separate from ACP execution `status`, and
shows the last observed management condition without creating per-card
subscriptions. Refresh rereads the same list. Disabled, not-created and
unhealthy Agents remain visible and can be opened for their existing
conversations; ACP still decides execution admission. If Controller discovery
is unavailable or not configured, bootstrap returns
`503 workspace_unavailable`; the authenticated shell stays usable and can retry.

Created/disabled displays Disabled; not_created displays Not created. For an
enabled created Agent, Runtime waiting/available/unhealthy/exited/absent/unknown
displays Waiting for startup/Available/Unhealthy/Stopped/Runtime missing/Runtime
status unknown. These labels do not promise model or network availability.
Unknown Runtime state is a reported observation; malformed or missing required
fields fail bootstrap instead of inventing an available Agent.

For the selected Agent, Node reads ACP's execution state
(`/rpc/agent-acp/get-agent-execution-state` and
`/rpc/agent-acp/watch-agent-execution-state`) and publishes it in the Agent
View. The browser observes that View through the Bridge SSE stream
`GET /api/app/workspace/v1/agents/{agent_id}/events`. The execution state
contains `availability`, `access_allowed`, `configuration_revision`,
`unavailable_reason` and the current principal's nullable `active_session_id`.
ACP is the authority; Gateway only authenticates and relays. The Gateway also
exposes the same ACP state directly for other clients; see the
[Gateway workspace state contract](../../edge-gateway/docs/workspace-state.md).

ACP remains the conversation protocol. State observation is read-only
admission feedback, not a Run journal, permission source or message transport.
Configuration revision is an opaque hash, not a Run sequence or replay cursor.
There is no browser database, storage of credentials, polling loop or prompt
resubmission.

## Consumer Lifecycle

Native EventSource handles SSE framing. The adapter validates each frame,
closes on invalid data or transport failure and disables native implicit retry.
The presentation observer immediately marks state uncertain, then retries with
bounded exponential backoff after refreshing authenticated bootstrap. A first
snapshot has a timeout. Agent switches, explicit refresh and unmount dispose
the previous stream, timers and pending bootstrap; late callbacks are ignored.
Snapshots belong to a unique selection/subscription lifetime, not just an Agent
ID: switching A to B to A cannot revive A's disposed readiness. Cancellation
feedback resets on a new subscription, even if the active Session ID is
unchanged.
Healthy streams do not poll. Gateway lease expiry uses the same recovery path.
Retry delay grows from one second to at most thirty seconds; a stable stream
resets it. Recovery reads never submit a new prompt.

Transport readiness, state freshness and selected-history readiness are
independent. Sending, attachments and configuration changes require all three
and an available Agent. Busy applies across conversations. Stop uses the local
outstanding prompt, otherwise the scoped active Session reported by ACP, never
the currently selected conversation. Sending a cancellation does not mean the
operation has stopped; only authoritative state enables new work. Losing
observation does not cancel work or disable an otherwise usable Stop for a
known local prompt.

Access loss removes the affected Agent and its cached conversations and
discards pending approvals. Recovery under a different User or Organization
discards the previous principal's cached history. Busy-to-ready or revision
changes refresh selected history/configuration only after a local prompt
settles; a replay does not overwrite its streaming response. Recovery refreshes
the Session list and reloads the selected Session. Input stays closed until
that history succeeds. Prompt preparation also has an admission signal: state
loss during Session creation or file reading prevents a later send, but does
not cancel a prompt already sent to the server.

## Testing

Unit tests cover wire validation; controlled EventSource/timer component tests
cover retry/disposal and authenticated recovery. App tests cover cross-session
busy/Stop, access loss, stale callbacks and completion. Docker, browser and
trace end-to-end behavior is covered by the root `tests/e2e/agent-ui/` suite.
