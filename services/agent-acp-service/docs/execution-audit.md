# Execution Audit

This document covers the retained Run input and the administrative audit RPCs
that read ACP execution history.

ACP owns execution audit independently of Controller's Agent/configuration
history. Queries never load or activate a Session, invoke tools/models, or
consult Controller. Deleting an Agent projection does not remove its audit.
The immutable Session organization identifies the historical access scope.

## Original Input

`runs.input_prompt` is the original trigger input, written with the Run intent.
It survives rejection, cancellation, normal completion and startup interruption.
The pending message identifier is only staging state and can be cleared.
Accepted input also becomes a conversation message for context/replay; rejected
input remains audit-only and is never injected into a later model request.
This stores one trigger, not a copy of the accumulated conversation context.
The service never adds platform Provider credentials to input or execution
snapshots. User input and tool output can still contain sensitive business data.

## Administrative Queries

Internal POST RPCs under `/rpc/agent-acp`:

- `list-execution-audits`: filters by Agent, Session and creation time; stable
  descending creation/id pagination, default 50 and maximum 100 items.
- `get-execution-audit`: Run metadata, original input, non-secret execution
  snapshot, terminal facts and per-request usage measurements. Missing usage
  remains unknown, not a fabricated zero cost.
- `list-execution-events`: reads either execution messages or permission
  records (`stream`), with separate opaque cursors. Execution messages retain
  Session sequence ordering; permissions retain creation/id ordering. There is
  no fabricated sequence spanning these two existing stores. Permission rows
  expose their current decision and timestamps, not a new event journal.

Gateway authenticates a current administrator and forwards its existing trusted
management context to Console BFF. BFF forwards the same context to ACP:
`X-Antnest-User-ID`, `X-Antnest-Organization-ID`, `X-Antnest-Membership-ID`,
`X-Antnest-System-Role`, and `X-Antnest-Organization-Role`.
ACP accepts a system administrator or organization administrator, always limited
to the verified organization in that context. Body/query fields cannot change
identity or widen organization scope. Ordinary owners use ACP Session APIs,
not administrative audit RPCs. Gateway must overwrite external identity headers.
Private-network trust is unchanged; these RPCs are not public OpenAPI routes.

Cursors contain only pagination anchors plus query scope. They are not access
credentials. Authorization is evaluated on every request, and every SQL query
constrains the immutable Session organization. A cursor for another query/scope
is rejected rather than silently changing the query. A missing or unauthorized
Run returns the same not-found response.

Creation filters use a half-open `[created_from, created_until)` UTC interval,
with seconds and up to six fractional digits (PostgreSQL microsecond precision).
Equal or reversed bounds are rejected without rounding to JS milliseconds.
Provider tool-call identifiers are opaque; permission cursors must preserve
them rather than imposing the format of platform-generated IDs. Request bytes
remain bounded by the shared HTTP body limit.

## Verification Boundary

Service-level validation covers input retention, read-only authorization,
deleted Session/Agent history, pagination, decoded tool details and permission
outcomes. No fresh execution configuration is required for historical reads.
Database failures are unavailable responses, not empty successful lists.
HTTP/RPC/DB tracing uses the normal service boundaries; no per-business-step
spans are added. Provider authentication is never joined into audit results.
When RPC content capture is enabled, audit requests and responses are captured
like other non-stream RPCs, including input/tool content. Keep it disabled where
that diagnostic data must not leave the audit database; OTLP is not an audit
store and does not replace database retention.

Regression coverage includes application authorization and cursor boundaries,
real PostgreSQL pagination/decoding and input retention, HTTP parent tracing,
and the production service startup/shutdown/restart path. The latter reads
deleted-Session history without any live execution snapshot, rejects ordinary
users and foreign organizations, and leaves new execution unavailable.

Gateway/BFF forwarding, real administrator login and cross-organization
negative cases are covered by the root
[Controller/ACP integration scenarios](execution-boundary-e2e.md). A locally
callable route alone does not show that the management UI can use this capability.
