# Admin Console

Admin Console is the administrator React application and thin BFF for Antnest
Platform. It presents Identity and Agent lifecycle facts without becoming a
second source of truth.

## Status

Implemented for Stage 3A, including Directory administration, enterprise
OIDC/SCIM provisioning, release-managed model provider presets, and
organization-scoped Model Profile and Template detail/revision management.
Known model capabilities come from Agent Controller; custom OpenAI-compatible
APIs expose explicit endpoint and limit fields. The canonical lifecycle workflow is
[`../../docs/stage-3-admin-control-plane.md`](../../docs/stage-3-admin-control-plane.md).
Agent Fleet presents current records by default, retains deleted projections
behind an explicit audit view, gates lifecycle commands from authoritative
state, and re-synchronizes Agent, event, and durable operation state after an
event-stream interruption.
Agent detail identifies the immutable Template and Model Profile revisions used
by the current executable configuration while keeping Provider credentials,
Runtime execution identity, and MCP routing outside the browser projection.
Its primary Agent read is independent from lifecycle-event history. An event
read or SSE recovery failure degrades only that evidence section, retains
already loaded events, and exposes a local retry only for transient failures
without hiding Agent state or valid lifecycle actions. Terminal `403`, `404`,
and `410` responses remain visible and stop automatic replay.
Active operation progress follows the same boundary. A failed operation lookup
is visible without replacing Agent detail; only a transient lookup is
retryable. The active request on the Agent projection continues to gate
conflicting commands, and stale operation responses cannot be presented under
a newer request. Later Agent refresh and owner-resolution failures preserve
their loaded projections and use the same structured retry policy.
SSE recovery does not join event replay and Agent refresh into a false client
transaction. Each successful read updates its own projection immediately and
each failure stays local. Event replay alone advances the cursor and reopens
the stream, while Agent refresh alone updates lifecycle command authority.
Event retry therefore does not repeatedly call the Agent endpoint. Concurrent
Agent responses converge by aggregate sequence instead of arrival order.
Revision-qualified links open read-only historical Catalog detail, so later
Template or Model updates do not rewrite an older Agent's explanation.
Those routes read only the requested immutable revision rather than coupling
history to the mutable current head. A Template's referenced Model revision is
loaded separately; if that lookup fails, the Template remains readable and the
Model label has its own retry.
Fleet summaries present human names, ownership, lifecycle, and time rather than
opaque Runtime revisions. A desired state appears only while lifecycle has not
converged; exact Agent/revision identifiers and lifecycle trace correlation stay
available in default-collapsed technical details for support work.
The distinction between split applications, pending owner services, current
Console defects, and undecided product concepts is tracked in
[`../../docs/product-surfaces.md`](../../docs/product-surfaces.md).
The Console links administrators to the separately deployed Agent workspace;
authenticated non-administrators are redirected there instead of being shown
administrator navigation.

The first-run guidance shown by Overview is deliberately stateless. It derives
Model, Template, Directory, and Agent readiness from the BFF overview;
owner-service failures are never presented as empty resources, and core list
pages expose an in-place retry or the precise missing-prerequisite action.
Overview names each degraded resource without exposing upstream diagnostics.
Its Active members metric counts only entries whose User and Organization
Membership are both active, while Directory continues to show disabled records
for administration.
Agent creation uses that active subset, but Fleet presentation resolves owners
from the complete Directory projection. Existing and deleted Agents therefore
retain a searchable human owner label after an account or Membership is
disabled.
Model Profile, Template, and Agent inventories traverse bounded owner-service
cursors. The BFF accepts only documented single-value pagination inputs,
injects organization scope, and translates the explicit deleted Agent view into
an authority-side lifecycle filter. Page failures preserve already loaded rows.
Model and Template dependency selectors reuse the same bounded cursor contract
across Template create/revise and Agent create/rebuild. Disabled records are
filtered from choices without discarding the continuation cursor, and a failed
later page can be retried without closing the form or losing loaded choices.
The four-owner overview aggregate is used only by the Overview page. Template
and Agent inventories issue independent primary and dependency reads, preserving
their loaded rows when Model, Runtime-default, or Directory creation options are
unavailable. `GET /api/admin/template-defaults` exposes only the configured
Runtime image reference and performs no owner-service read.
Model Profile inventory and detail also load independently from the built-in
Model Catalog. A Catalog failure keeps stored Profile facts readable under
their persisted display name while disabling only connect/revise actions until
the section-local retry succeeds.
OIDC Provider and SCIM credential inventories load independently, so one failed
Identity read cannot erase the other management surface. Directory and
Provisioning mutations report failures inside the active form or confirmation
and retain entered values for retry. One-time SCIM credentials remain only in
page memory, including when clipboard access fails.
Organization scope remains server-side. Group and OIDC database IDs are omitted
from browser DTOs; a SCIM token ID is retained only for its revoke action and is
not rendered as user-facing credential identity.
Provisioning also exposes the exact same-origin Edge OIDC callback and SCIM
base URL in their relevant setup flows. These public protocol addresses are
derived from the browser origin, never from internal service discovery or a
user-editable base URL.
The account area resolves a safe current-account projection from Identity and
shows the administrator's display name, email, and Organization name/slug
instead of opaque internal IDs. The BFF uses principal IDs only for the upstream
binding and strips them from this browser DTO. The shell and Directory surface
reuse those presentation fields rather than rendering organization IDs. It
exposes local Antnest password rotation only when Identity confirms that the
User has a local credential. A profile-read failure is locally retryable, uses
neutral shell labels, and fails closed without blocking the rest of the
Console. The BFF derives the target User from the trusted principal, and the
browser neither stores the credential fields nor exposes this command as
another-user administration.

## Owns

- React/shadcn administrator UI and page-local state;
- page-oriented request shaping and response aggregation;
- explicit browser DTO allowlists that keep control-plane fields internal;
- organization scoping from Edge Gateway's trusted principal;
- static application delivery and lifecycle event forwarding.

The overview executes its independent reads concurrently under one deadline.
Agent inventory is required; directory and catalog sections degrade with named
status envelopes instead of erasing unrelated data. Its Catalog and Agent
sections remain bounded owner-service pages and preserve continuation cursors;
the application labels counts as lower bounds and scopes lifecycle breakdowns
to loaded records whenever another page exists.
Failures preserve safe HTTP status, including terminal `403`/`404`/`410`, in
both the required-read response and optional section errors. The page offers
refresh only for transient failures, preserves its loaded snapshot while
refreshing, and disables duplicate refresh requests. Leaving the page cancels
the pending read.

`npm --prefix services/admin-console/web test` runs pure-function tests followed
by Vitest/Testing Library component tests with one worker. Dashboard component
tests exercise the real API parser and rendered controls using HTTP-shaped
fetch responses, including snapshot retention, transient recovery, terminal
failure, and unmount cancellation. They require no external provider or Docker.

## Does Not Own

- browser login, external authorization, or session cookies;
- Identity, ModelProfile, Template, Agent, operation, event, or Runtime records;
- Provider secret retrieval;
- any PostgreSQL schema.

## Dependencies

- Edge Gateway as the only external caller;
- Identity Service for organization-scoped directory reads, local-user and
  Membership commands, system-administrator User lifecycle commands, OIDC
  Provider administration, SCIM credential rotation, current-account profile
  and local-credential capability reads, and self-service local password
  changes;
- Agent Controller for catalog, Agent lifecycle, projections, and events;
- OTLP collector when observability is enabled.

## Interfaces

See [`../../contracts/admin-console/admin-contract.json`](../../contracts/admin-console/admin-contract.json).

## Local Verification

```sh
go test ./...
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
golangci-lint run ./...
```

See [architecture](docs/architecture.md) and [operations](docs/operations.md).
