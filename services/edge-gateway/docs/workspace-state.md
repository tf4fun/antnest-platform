# Workspace State Gateway

## Boundary

`GET /api/app/agents/{agent_id}/state` and `/state/watch` use the existing
browser session. They accept no query fields, replay cursor or caller-supplied
principal. A supplied Origin must match Gateway. Organization and principal
come only from Identity resolution; Agent Controller enforces Agent access.
Origin comparison includes both scheme and host. This direct-listener Docker
profile does not trust caller-supplied forwarded scheme headers; an external
TLS-terminating proxy needs a separately designed trusted-proxy configuration.
An administrator receives no additional workspace access merely by role.

The response is the allowlisted Controller snapshot: `agent_id`, `availability`,
`access_allowed`, `agent_revision`, nullable `active_session_id`. See the
[producer contract](../../agent-controller/docs/workspace-state.md).
Gateway owns no Agent state, session history, database or new event journal.

## Streaming

Watch emits `event: workspace_state` and a full JSON snapshot. It has no event
IDs or Last-Event-ID. Controller frames are bounded, decoded, validated against
the requested Agent, then re-encoded. Unknown fields, malformed frames,
oversized payloads and wrong Agent identities are not forwarded. Only a valid
first snapshot commits HTTP 200. Upstream headers and cookies are not relayed.

The first snapshot is bounded by the request timeout. An entire subscription
is bounded by `ANTNEST_EDGE_STREAM_LEASE` (existing default: five minutes), with
no in-process renewal. Per-frame socket writes also have a deadline. There are
64 state subscription slots, separate from ACP connections/message slots, so
state observation does not consume cancellation capacity.

Service shutdown cancels registered workspace watches alongside WebSockets and
waits for their handlers and trace completion before shutting down telemetry.
Ordinary non-stream HTTP requests retain graceful drain behavior. Lease expiry
is not the mechanism used to stop a service-owned stream during deployment.

Identity is resolved at entry and before each subsequent snapshot. It must
remain the same active User, Organization and Membership. Revocation or natural
expiry rejects the next snapshot; a quiet stream expires at its lease boundary.
This is bounded revalidation, not an instantaneous revocation guarantee or an
idle authorization poll. A Controller access-loss snapshot is forwarded only
to a still-valid original principal, then the stream closes.

Before streaming, invalid sessions return 401 and clear cookies, Identity
outages return 503 without clearing cookies, and unknown/inaccessible Agents
return 404. After streaming begins, failures close the stream without appending
JSON errors or fabricating readiness. A client must mark state uncertain,
refresh authentication/access, reconnect with backoff, and fetch a fresh
snapshot. It must never replay a prompt to recover observation. A transport
disconnect cancels the Controller watch only, not the ACP Run.

## Verification And Integration

Service tests cover exact identity scope, cross-origin/cursor rejection,
upstream privacy/schema validation, fragmented SSE, initial-response failure,
lease expiry, identity changes, dependency outages, cancellation and capacity
release. Incoming Gateway trace context must parent Identity and Controller
client spans, including watch termination. No raw upstream payload or token is
logged. Tests use controlled HTTP dependencies, not another service's DB.
The response observation wrapper preserves Flush errors. Dependency span status
uses fixed classifications/HTTP status, never raw Identity error codes, bodies
or transport exception text. Tracers are resolved against the active provider.

Controller, Gateway and Agent UI consumption are implemented, with Docker state,
conversation recovery and Gateway-rooted trace evidence recorded in
[C4 closeout](../../../docs/docker-single-node-closeout.md). Complete interactive
browser acceptance and the final platform Jaeger report remain open; the
service tests above are not substitutes for those checks.
