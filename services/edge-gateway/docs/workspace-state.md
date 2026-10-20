# Workspace Bridge Entry

Gateway 24 exposes browser workspace traffic through `/workspace/*` and
`/api/app/workspace/v1/*`, using the configured Agent UI origin. The old
`/api/app/bootstrap`, Agent state/watch and direct ACP aliases return
`404 not_found` after outer Origin admission, including HEAD and upgrade
requests, without Identity or downstream calls.

## Ownership

Agent UI owns bootstrap, view and event DTOs, commands, prompt delivery and
browser recovery. ACP remains its private execution authority. Gateway no
longer queries Controller discovery, validates/re-encodes six-field ACP state
snapshots or synthesizes Agent availability. An unavailable or inaccessible
Agent must retain the owning service's error and disclosure semantics.

Gateway establishes browser-session and route scope, applies Origin and
session-bound CSRF admission, strips reserved headers and trailers, and forwards
verified presentation hints plus the unchanged Identity CCT with workload
authentication. Labels never confer resource authority. See
[execution ownership](execution-boundary.md) and the
[header contract](../../../contracts/edge-gateway/request-headers.md).

## Streaming and recovery

`GET /api/app/workspace/v1/agents/{agent_id}/events` forwards one validated
Last-Event-ID of at most 4096 bytes and flushes SSE without buffering a full
stream. Agent UI owns event contents, replay and reset semantics. Gateway
reserves one of 64 Bridge receive slots and bounds the observer by
`ANTNEST_EDGE_STREAM_LEASE`.

The browser guard starts before opening upstream and retains the original SID,
User/Organization/Membership, roles and absolute session deadline. Non-touch
checks continue while quiet, with a maximum 30-second stale-output bound
anchored to the source's actual Resolve RPC start, including request latency
and connection closure. Cache hits cannot reset that age. Returned snapshots
must retain valid idle, absolute and CCT deadlines; a live check can observe
new idle eligibility without changing the original identity.

The private session feed accelerates closure without replacing bounded checks.
Revocation, stale authority, lease expiry or cancellation interrupts blocked
writes, cancels the upstream receive request and joins owned work. After a
stream commits, failure closes it without appending a fabricated state or JSON
error. Browser uncertainty, reconnect and command deduplication remain Agent
UI responsibilities; reconnect must not replay a prompt.

Disconnect ends observation only. It does not cancel an accepted Run. A user
cancellation uses the admitted Bridge command/operation API and must be
confirmed by the actual execution owner.

## Verification and capacity

Gateway tests use real HTTP dependencies for trusted scope, header/trailer
stripping, SSE flush, live revalidation, blocked writes, disconnect, shutdown,
trace parenting and slot release. At 64 held streams another user's command
can still be forwarded; that is a Gateway boundary check, not proof of real
Agent UI/Runtime cancellation.

The [retirement policy](../../../contracts/edge-gateway/workspace-entry-retirement.md)
separately requires authenticated private ACP protocol coverage, retained Bridge
business journeys, Agent UI upload-budget checks and two-user production-image
integration. Its cancellation gate measures the same held Run and Runtime work
through actual terminal state and quiescence during both body reception and
EOF parse/hash/serialization.
