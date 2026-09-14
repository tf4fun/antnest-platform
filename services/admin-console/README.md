# Admin Console

Provider connections, credential rotation and model metadata now have separate
management workflows. Builtin defaults remain Console-owned, persisted choices
Controller-owned. See [Provider management](docs/provider-management.md) for
routes, boundaries and verification. Custom providers and subscription login
are not yet exposed.

Template creation and revision include optional **MCP servers**: stdio command,
ordered arguments and environment variables. Template details retain the complete
configuration; Agent details show the deployed server IDs and commands. Publish a
revision, then explicitly rebuild Agents to apply it. See
[Managed MCP configuration](docs/managed-mcp.md) for ownership, privacy and tests.

Admin Console is the administrator React application and thin BFF for Antnest
Platform. It presents Identity and Agent lifecycle facts without becoming a
second source of truth.

## Status

The execution-boundary B4 batch adds direct ACP audit reads, an independent
Execution history page and a separate Controller synchronization read. See
[Execution audit](docs/execution-audit.md). Original input, execution snapshots,
Tool events and permission records remain accessible for deleted Agents without
a Controller detail lookup. The history page has independent pagination and
refresh for execution and permission records, plus desktop/mobile browser tests.
Provider, Model and current Template details now expose availability controls and
Controller reference conflicts. Configuration pages separately show delivery
pending, acknowledged or unknown; an acknowledgement is not Agent readiness.
See [Catalog availability](docs/catalog-availability.md). The service-local
implementation still requires the combined Gateway/Controller/ACP B5 acceptance.

Implemented for Stage 3A, including Directory administration, enterprise
OIDC/SCIM provisioning, release-managed model provider presets, and
organization-scoped Model Profile and Template detail/revision management.
Builtin model capabilities come from Console; Controller persists the selected
configuration. Only DeepSeek connections are currently enabled. Unlisted models
under an existing connection expose explicit limit and Image/Audio/PDF fields. Native
capabilities are preserved across BFF projections, creation and current-model
editing; builtin presets prefill editable drafts, while saved values take precedence. See [Native model inputs](docs/multimodal-models.md)
for the F09 service boundary. Agent UI and protocol deployment results are in
[ACP conformance](../agent-acp-service/docs/protocol-conformance.md); full C4
interactive acceptance remains separate.
Model pricing now follows the Controller's optional USD-per-million contract:
catalog estimates by default, editable rates, immutable historical snapshots,
and explicit unknown versus zero. Console owns builtin default metadata only. Organization configuration and
credentials remain in Controller's database. See [Model pricing](docs/model-pricing.md) for this service's evidence
and [ACP conformance](../agent-acp-service/docs/protocol-conformance.md) for the
completed F10 consumer/deployed integration batch.
The canonical lifecycle workflow is
[`../../docs/stage-3-admin-control-plane.md`](../../docs/stage-3-admin-control-plane.md).
Agent details include an independent public-network policy switch. It saves a
single version-checked assignment through Controller without rebuilding an Agent
or opening a paused attachment. Uncertain updates survive page close and retain
their original retry identity; stale-account requests are rejected before
dispatch. See [Network policy management](docs/network-policy.md).
Agent Fleet presents current records by default, retains deleted projections
behind an explicit audit view, gates lifecycle commands from authoritative
state, and re-synchronizes Agent, event, and durable operation state after an
event-stream interruption.
An unfinished deletion remains in the current administrator fleet. A failed
cleanup can be explicitly retried, but cannot be enabled or rebuilt. Only a
completed deletion enters the retained view. Unknown HTTP results retain their
request key; observing the resulting terminal operation establishes a new intent
boundary for the next explicit command.
Deleted Agent details stay open for audit, including after a live deletion
completes. Replaying a completed operation never redirects the page. The active
request distinguishes `Current operation` from `Last operation`; a terminal
phase that duplicates the state is omitted without hiding failure diagnostics.
Lifecycle admission is acknowledged independently of the following Agent read.
A refresh failure preserves that receipt, closes stale-state actions, and retries
only the read. Rebuild and delete rejections stay inside their originating dialog;
pending dialogs cannot be dismissed. Agent identity scopes this local form state,
so a different Agent cannot inherit an earlier command's pending form or error.
Agent detail shows the immutable Template revision and model parameters saved
in its build snapshot while keeping Provider credentials,
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
each failure stays local. After successful replay, recovery awaits one Agent
refresh before reopening the stream; a refresh failure is recorded locally and
does not prevent reopening. This read-after-replay closes the missed terminal
state window. Failed replay retries do not repeatedly call the Agent endpoint. Concurrent
Agent responses converge by aggregate sequence instead of arrival order.
Template revision links open read-only historical detail. Model links open the
current settings; the Agent's build snapshot remains visible on Agent detail and
is not replaced by those settings. Templates resolve their stable model identity
separately; if that lookup fails, the Template remains readable and the Model
label has its own retry. There is no independent model history page.
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
The Template form offers the platform default or an explicit repository/tag,
without a digest input. If no default is configured, the tag input is required.
Revision forms default to keeping the current pinned image and do not read a
potentially changed deployment default. An explicit tag choice is sent to Agent
Controller, which resolves and freezes it through Runtime Controller. This BFF
does not inspect Docker, pull images, or assert an image-to-tag mapping.
Template and Agent details show the server-derived `image_source` when present,
otherwise a repository/tag or `Platform runtime` for an unnamed image ID.
Reusable tests cover digest-free labels, explicit tag selection, missing-default
creation, source projection, rejection feedback, and preserving pinned images
when deployment defaults change or vanish. Rejected tag choices remain editable
inside the dialog; no unpublished revision is shown as successful.
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
An incorrect current password is a `401 invalid_current_password` form error;
an expired/revoked session is still a login failure on that same endpoint.
Unknown or unreadable protected-API 401 responses also end the current page
session. Pending requests cannot emit expiry notifications into a later
in-page session. This does not replace Edge's cookie/revocation authority.
Sign-out waits for Edge to confirm revocation and cookie removal before showing
the login page. While pending, the action is disabled; a rejection stays visible
beside the account controls instead of falsely presenting a completed sign-out.
Confirmed logout and authoritative session expiration close the drawer and
account dialog. A late response to an earlier logout cannot affect a subsequent
login. `web/src/App.test.tsx` covers this through the real application and API
wrapper; Edge owns and separately tests cookie and revocation semantics.
Startup also preserves HTTP failure semantics: only a missing/expired session
opens login. Terminal access or missing-endpoint errors have no retry action;
transient failures retry the session query in place, without document reload or
early protected-resource reads. The pending retry cannot be submitted twice.

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
Inventory component tests cover Model, Template, Current Agent, and Deleted
Agent traversal using the real API parser: terminal failures retain loaded
rows without retry, transient retries keep their cursor, and pending requests
cannot be duplicated. Deleted-read failures persist across tab switches rather
than triggering an automatic fetch loop. Catalog creation tests also cover
ambiguous responses, stable retry identities, and dismissible success feedback.
Directory and Provisioning component tests cover mutation rejection without
input loss, successful writes followed by unavailable/forbidden reads, stale
row-action prevention, system-only OIDC entry, and SCIM credential disposal and
clipboard recovery. They distinguish the command result from refresh status.
Catalog revision component tests verify rejected-input retention, pending
publication and server-returned revision feedback, read-only historical routes,
terminal detail failures, and referenced Model recovery without resubmitting a
Template publication.
Agent mutation component tests cover creation retries, lifecycle admission
acknowledgements, rejected dialogs, follow-up Agent read failures, and read-only
recovery that keeps stale actions closed. They also verify that another Agent
cannot inherit the previous detail's pending dialog or late rejection. Retained
deletion and live-event completion have separate component coverage; opening
completed history is not a navigation command.
`web/src/components/account-security.test.tsx` covers password form validation,
pending submission and dismissal, HTTP/network rejection, explicit retry,
successful completion, and credential clearing without persistent browser
storage. These tests exercise the real API wrapper with synthetic responses;
they do not rotate an account's actual password.
The Stage 3 Docker E2E also repeats Model and Template creation with the same
idempotency key and verifies that their inventories contain no duplicate. Agent
organization isolation is checked through the owner's scoped interface while
browser responses remain free of internal organization fields. Test cleanup
stops asynchronous creators before removing their scoped resources and rejects
leftover containers or volumes.

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
- ACP for organization-scoped execution audit, independently of live Agent projections;
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
