# Admin Console Architecture

## Modules

```text
web/                 React application and shadcn UI components
internal/principal/  trusted Edge Gateway principal parser
internal/upstream/   traced Identity and Agent Controller clients
internal/server/     BFF request shaping, scope checks, and static fallback
internal/telemetry/  HTTP spans, correlated logs, and OTLP lifecycle
cmd/admin-console/   composition and shutdown only
```

The BFF receives a verified principal from Edge Gateway. It generates request
IDs and authority fields, then calls the existing language-neutral internal
contracts. Browser JSON cannot select another organization or impersonate an
actor.

Internal RPC payloads are never raw-proxied on successful reads. The server
projects explicit browser DTOs and omits Provider credential references, Agent
access subjects/revisions, Runtime execution identities, MCP endpoints, and
event data. This is an allowlist boundary: a new internal field remains private
until the BFF deliberately exposes it.

The overview is a non-persistent presentation aggregate. Four buffered reads
share one bounded context and execute concurrently; goroutines never write the
`ResponseWriter`. Agent inventory is required. Directory, Model Profile, and
Template sections return stable `available`/`unavailable` envelopes so one
optional dependency does not erase authoritative fleet state.
Unavailable envelopes carry a safe HTTP status and fixed business-resource
label, never an upstream URL or error body. The browser retains structured
failure semantics and offers one aggregate refresh only for transient failures.
A terminal required-read failure suppresses retry even if the retained snapshot
contains an older transient section failure. A pending refresh keeps that
snapshot visible and disables the refresh control; leaving the page cancels the
read and ignores its completion. Browser metrics derive Active members from the conjunction
of User and Organization Membership state, matching Agent-owner admission.
Agent pages derive two views from that single Directory response: an active
selection set for create commands and a complete User index for existing fleet
presentation. The selection policy never destroys historical display context.

Only the Overview page consumes that aggregate. Template and Agent pages use
their primary list route plus independently recoverable dependency reads. This
avoids duplicate owner queries and prevents the Overview's required Agent read
from becoming an accidental prerequisite for Template administration. The
Template page obtains the presentation-owned default Runtime image from a
small, non-persistent BFF response that calls no owner service.

Organization Model Profiles are authoritative stored resources; the built-in
Model Catalog is release-managed editing metadata. Their browser requests and
states are independent. Catalog loss falls back to each Profile's persisted
display name and closes only mutation entry points, rather than replacing a
valid inventory or immutable detail with a page-level error.
Current-head and revision-qualified Catalog routes are alternative primary
reads, not mandatory fan-out dependencies. Historical Model and Template pages
therefore issue only the immutable revision request. Template-to-Model
resolution is a separate presentation state: its failure produces a local
retry while the authoritative Template revision remains on screen.

Lifecycle reads are authoritative snapshots. SSE is a wake-up/experience
channel; reconnecting clients independently replay events and refetch the Agent
projection, then recover operation detail from those authoritative results.
The initial Agent projection and event baseline are separate reads. Agent
failure blocks the detail resource; event failure leaves the primary resource
available and provides a section-local retry only for transient failures. A
failed reconnect preserves previously rendered events, de-duplicates replay by
event identity, and advances the cursor only from an authoritative response.
Terminal `403`, `404`, and `410` replay failures stop automatic recovery and do
not render a retry action.
Replay and Agent refresh are not a browser-side transaction. Replay success
advances its cursor and reopens SSE even if Agent refresh fails; Agent refresh
success updates lifecycle state even if replay fails. Only replay retries on a
replay failure, avoiding repeated unrelated Agent reads. A cross-reconnect
operation hint preserves either response order: an active request from the
Agent projection has priority, otherwise the newest operation-bearing replayed
event supplies terminal progress.
Concurrent Agent reads accept snapshots by monotonic aggregate sequence rather
than request completion order. A slower valid initial read can still establish
the page when a newer recovery read fails, while a late older projection cannot
regress an already rendered Agent.
Durable operation detail has its own keyed request state. The Agent projection's
`active_operation_request_id` remains the command-gating authority even when
the operation read fails. The browser reports that failure locally, retries the
same request explicitly only when the failure is transient, rejects an
operation belonging to another Agent, and ignores every response superseded by
a newer active request. Owner Directory and later Agent refresh failures retain
their last valid projections and follow the same structured terminal/transient
policy. A terminal Operation failure suppresses automatic reads for that same
request ID, while a failed Agent refresh closes lifecycle commands until fresh
authority is available.

Provisioning connection addresses are presentation facts derived from the
browser-visible Edge origin. OIDC uses `/protocol/oidc/callback` and SCIM uses
`/scim/v2`; current paths, queries, and fragments cannot influence either
address. Admin Console does not expose or discover Identity Service's internal
network location.

The account summary is a non-persistent Identity projection. Admin Console
injects actor and organization from the trusted principal, then allowlists only
display name, email, source, Organization name/slug, and the authoritative
`local_password_available` capability. User, Membership, and Organization IDs
are internal query-binding facts and are stripped from this browser DTO. The
browser does not derive password capability from Membership source. An
unavailable summary keeps the Console usable, shows a local retry, presents
neutral labels instead of IDs, and hides credential actions.

Account password rotation is a self-targeting command. Admin Console injects
both actor and target User from the same trusted principal, forwards the two
password fields once to Identity Service, and allowlists only the resulting
status. Password values never enter browser storage or a durable Console retry
record.
Because Edge has already authenticated the protected request, an Identity 401
from this command represents an invalid current password rather than an
expired browser session. The dialog keeps that failure local; other protected
Admin API 401 responses still trigger session-expiry handling.

## Failure Semantics

- missing or malformed trusted identity context fails closed;
- upstream `4xx` domain errors are preserved for the UI;
- dependency transport failure returns `503` and never fabricates success;
- required overview failure preserves safe HTTP status; transport failure is
  `503`, invalid projection/response is `502`; optional failure retains status
  in a named degraded section in a successful aggregate;
- a resource outside the principal organization is exposed as `404`;
- secret input is forwarded once and never logged or returned by the BFF.
- current-account failure degrades only the account card; password capability
  fails closed until an Identity response is available;
- password validation or Identity failure remains in the account dialog while
  the administrator decides whether to retry or close it;
- clipboard failure leaves the protocol address or one-time credential visible
  and retryable in the originating setup surface.

## Extension Rules

New pages may aggregate reads, but writes remain one command to one owning
service. A workflow that needs durable retries or cross-service state belongs in
the domain controller, not in this presentation service.
