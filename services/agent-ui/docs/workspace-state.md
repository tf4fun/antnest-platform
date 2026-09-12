# Workspace State Observation

## Contract And Ownership

Agent UI subscribes to the selected Agent through the authenticated Gateway
`GET /api/app/agents/{agent_id}/state/watch`. The full snapshot contains only
`agent_id`, `availability`, `access_allowed`, `agent_revision` and the current
principal's nullable `active_session_id`. See the
[Gateway contract](../../edge-gateway/docs/workspace-state.md).

ACP remains the conversation protocol. The state subscription is read-only
admission feedback, not a Run journal, permission source or message transport.
Agent revision is not a Run sequence or replay cursor. There is no browser
database, storage of credentials, polling loop or prompt resubmission.

## Consumer Lifecycle

Native EventSource handles SSE framing. The adapter validates each snapshot,
closes on invalid data or transport failure and disables native implicit retry.
The presentation observer immediately marks state uncertain, then retries with
bounded exponential backoff after refreshing authenticated bootstrap. A first
snapshot has a timeout. Agent switches, explicit refresh and unmount dispose
the previous stream, timers and pending bootstrap; late callbacks are ignored.
Snapshots belong to a unique selection/subscription lifetime, not just an Agent
ID: switching A to B to A cannot revive A's disposed readiness. Cancellation
feedback resets on a new subscription or ACP connection, even if the active
Session ID is unchanged. Cancelling ACP initialization closes its transport
without waiting for initialize or Session listing to return.
Healthy streams do not poll. Gateway lease expiry uses the same recovery path.
Retry delay grows from one second to at most thirty seconds; a stable stream
resets it. ACP disconnection separately refreshes access and reconnects with the
same bounded-delay policy. Recovery reads never submit a new prompt.

ACP transport readiness, state freshness and selected-history readiness are
independent. Sending, attachments and configuration changes require all three
and an available Agent. Busy applies across conversations. Stop uses the local
outstanding prompt, otherwise the scoped active Session reported by Gateway,
never the currently selected conversation. Sending a cancellation notification
does not mean the operation has stopped; only authoritative state enables new
work. Losing observation must not cancel work or disable an otherwise usable
ACP Stop for a known local prompt.

Access loss removes the affected Agent and its cached conversations, closes its
ACP connection and discards pending approvals. Recovery under a different User
or Organization discards the previous principal's cached history. Busy-to-ready
or revision changes refresh selected history/configuration only after a local
prompt settles; a replay must not overwrite its streaming response.
Recovery refreshes the Session list and loads the selected Session on a new ACP
connection. Input stays closed until that history succeeds. Prompt preparation
also has an admission signal: state loss during Session creation or file reading
prevents a later send, but does not cancel a prompt already sent to the server.

## Verification Boundary

Unit tests cover wire validation; controlled EventSource/timer component tests
cover retry/disposal and authenticated recovery. App tests cover cross-session
busy/Stop, access loss, stale callbacks and completion. Official ACP SDK tests
remain in place. Docker/browser/Jaeger end-to-end acceptance follows this
service-owned batch and is not implied by local component results.
