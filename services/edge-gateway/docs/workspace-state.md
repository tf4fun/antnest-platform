# Workspace State Gateway

## Boundary

`GET /api/app/bootstrap` lists every authorized, non-deleting Agent via the
Controller's scoped paginated list. Items contain agent_id/name and management
lifecycle_state/runtime_state, with activation_state only when created. Gateway
validates and relays these facts without new ACP/Runtime calls. They are deployment
observations, not execution availability; starting, disabled and unhealthy Agents
remain listed. No credentials, endpoints or Session data are included.

`GET /api/app/agents/{agent_id}/state` and `/state/watch` authenticate the
browser session. They accept no query fields, replay cursor or supplied
principal. Origin must match both scheme and host when present. This direct
Docker listener does not trust forwarded scheme headers.

Gateway sends an empty JSON object by POST to ACP's
`/rpc/agent-acp/get-agent-execution-state` or
`/rpc/agent-acp/watch-agent-execution-state`. It supplies the authenticated
Organization/Principal and route Agent ID in trusted headers. ACP, not an
administrator role or a Controller discovery list, decides resource access.
Neither path calls Controller. See the
[ACP producer contract](../../../contracts/agent-acp/execution-api.md).

Each complete view contains `agent_id`, `availability`, `access_allowed`,
nullable `configuration_revision`, nullable `active_session_id`, and nullable
`unavailable_reason`. Configuration revision is an opaque 64-character digest,
not an ordered Agent aggregate version. Busy/idle changes must not be interpreted
as configuration replacement. Gateway validates and relays views; it owns no
execution state, history, database or event journal.

Missing/inaccessible Agents have the same sanitized offline view, with no
Session or configuration revision and reason `access_denied`. This is a valid
HTTP 200 response, including as the first watch snapshot. An authorized offline
view can report `agent_unavailable` or `runtime_barrier_required`; an in-flight
Run can remain busy while new execution is disabled. ACP owns these semantics.

## Streaming

Watch emits `event: workspace_state` and a full JSON snapshot, without event
IDs or replay. Frames are bounded, decoded, validated against the requested
Agent, then re-encoded. Unknown fields, malformed/oversized frames and wrong
Agent IDs are not forwarded. Only a valid first snapshot commits HTTP 200.
An ACP `workspace_error` ends observation as a source failure, never as idle,
ready or permission revocation. Its raw body is not forwarded or logged.

The first snapshot is bounded by the request timeout. A subscription is bounded
by `ANTNEST_EDGE_STREAM_LEASE` (default five minutes), without in-process
renewal. Frame writes have deadlines. There are 64 state slots separate from
ACP receive/message slots, so observation does not consume cancel capacity.

Identity is resolved at entry and before subsequent snapshots. It must remain
the same active User/Organization/Membership. Identity revocation, expiry or
outage stops delivery. A valid ACP access-loss snapshot is delivered to the
still-valid original identity and closes the stream. A quiet stream expires
at its lease boundary; there is no idle authorization polling.

Before streaming, invalid browser sessions return 401; Identity or ACP outages,
malformed responses and missing internal routes return 503. No dependency
failure is treated as Agent absence. After streaming starts, failures close
the stream without appending JSON errors or inventing a state. Clients mark
state uncertain and reconnect with backoff; they must not replay prompts.
Disconnect cancels the ACP watch request only, not the Run. Service shutdown
cancels and drains watches before telemetry shutdown.

## Verification And Consumer Delivery

Service tests cover trusted scope, no Controller dependency, malformed and
sanitized views, fragmented SSE, source failure, identity changes, lease
expiry, browser disconnect, shutdown, trace parenting and capacity release.
Tests use controlled HTTP dependencies, not another service's database.
Identity and ACP client spans must be children of the Gateway HTTP span.

Bootstrap management state is browser contract revision 12. Agent UI
bootstrap/state migration is the separate B4U batch; Console audit consumption
is B4. Docker/Temporal/Jaeger acceptance is B5. Previous stack evidence does
not establish acceptance of this producer/consumer change.
