# Admin Console Architecture

Builtin model defaults are maintained by this service in
`internal/server/builtin_catalog.go` and served by `/api/admin/model-catalog`.
The catalogue is draft input only: organization configurations and credentials
are read/written exclusively through Controller RPC, never through its database.
Connections, independent credential rotation and models are separate BFF/UI
workflows. Only the opaque credential version required for rotation CAS is
projected, never key material. Model edits cannot change their connection or API
model ID. See [Provider management](provider-management.md).
See [provider ownership](../../../docs/provider-credentials-and-models.md).

Managed stdio MCP is part of the immutable Template Runtime configuration, not a
Console-owned service catalog. The BFF forwards bounded JSON to Agent Controller
for validation and storage, never starts processes or accesses another service's
tables. Only administrator Template detail/write responses expose arguments and
environment values; list/Overview omit them, and Agent configurations project
server ID/command summaries. All responses are `no-store`. See
[Managed MCP](managed-mcp.md) for the editor and explicit rebuild workflow.

## Modules

```text
web/                 React application and shadcn UI components
internal/principal/  trusted Edge Gateway principal parser
internal/upstream/   traced Identity, Agent Controller and ACP clients
internal/server/     BFF request shaping, scope checks, and static fallback
internal/telemetry/  HTTP spans, correlated logs, and OTLP lifecycle
cmd/admin-console/   composition and shutdown only
```

The BFF receives a verified principal from Edge Gateway. It generates request
IDs and authority fields, then calls the existing language-neutral internal
contracts. Browser JSON cannot select another organization or impersonate an
actor.

Execution audit is read directly from ACP, independently of Controller's current
Agent projection. Configuration synchronization is a separate Controller read.
See [execution audit](execution-audit.md) for routes, trusted identity forwarding,
and the pending integration delivery boundary. [Catalog availability](catalog-availability.md)
uses one Controller command per explicit change; the browser renders reference
conflicts and configuration acknowledgement without becoming their authority.

Internal RPC payloads are never raw-proxied on successful reads. The server
projects explicit browser DTOs and omits Provider credential references, Agent
access subjects/revisions, Runtime execution identities, MCP endpoints, and
internal management event data. Execution-audit DTOs deliberately retain input,
tool and permission content. This is an allowlist boundary: a new internal field remains private
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
valid inventory or detail with a page-level error.
Models have only a current detail read. Template current and historical detail
routes are alternative primary reads, not mandatory fan-out dependencies. Template-to-Model
resolution reads the stable `model_profile_id` current head as a separate
presentation state: its failure produces a local retry while the authoritative
Template revision remains on screen. Template history preserves the template's
model identity, not a pinned model metadata revision. Agent build detail reads its own immutable snapshot, not today's model
parameters. A model link opens current settings, not a historical resource.

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
commits events/cursor, then awaits one Agent refresh before reopening SSE. That
refresh has a local failure state and cannot prevent reopening; it closes the
missed-terminal-state window after replay. Other successful Agent reads still
commit independently. Only replay retries on a replay failure, avoiding
repeated unrelated Agent reads. A cross-reconnect
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
Identity's password RPC currently returns `401 unauthenticated` only when the
credential comparison fails. This specific response becomes
`401 invalid_current_password` with a fixed message at the BFF; it stays in the
dialog. Other protected Admin API 401 responses, including malformed responses
and Gateway rejections on the password route, trigger session-expiry handling.
Request notifications belong to the browser session in which they started;
late responses cannot invalidate a newly established session.
This guard covers in-page notifications, not browser-applied `Set-Cookie`
headers from concurrent HTTP responses or sign-ins in another tab.

The mapping is not a guarantee that the session is still valid when the
response arrives. Revocation after Gateway admission is checked on the next
protected request. Inactive actors, missing credentials, concurrent password
replacement and dependency failure retain their distinct upstream errors.

## Failure Semantics

- missing or malformed trusted identity context fails closed;
- upstream `4xx` domain errors are preserved for the UI;
- dependency transport failure returns `503` and never fabricates success;
- required overview failure preserves safe HTTP status; transport failure is
  `503`, invalid projection/response is `502`; optional failure retains status
  in a named degraded section in a successful aggregate;
- a resource outside the principal organization is exposed as `404`;
- successful Directory commands keep their acknowledgement through the next
  read; loaded records remain readable but row mutations require a fresh
  snapshot, and an explicit refresh retry cannot create concurrent reads;
- Provider row editing closes during pending mutations; SCIM issuance and its
  one-time credential are independent of subsequent list-read availability;
- initial and subsequent inventory pages retain structured terminal/transient
  failures; pagination never defaults an unclassified error to retryable;
- Deleted Agent reads start on first use, not on each failure or tab switch;
  only explicit transient retry repeats a failed read, and each Fleet view
  retains its own cursor, loaded records, and failure;
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
