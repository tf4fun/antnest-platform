# Product Surfaces And Feature Convergence

> Status: accepted direction; implementation tracked by category  
> Updated: 2026-09-03

This document separates four situations that otherwise look identical in the
browser: a feature intentionally moved to another application, a feature whose
owner service does not exist yet, an implemented domain capability that the
Console failed to expose, and a product concept whose ownership is still
undecided. Only the third case is a current Console defect.

The pre-split monolith is a feature inventory, not the target navigation model.
The new platform restores useful workflows without recreating its service
coupling or presenting unavailable controls.

## Product Boundary

Antnest has two browser applications:

| Application | Audience | Owns the experience | Stable entry |
| --- | --- | --- | --- |
| Admin Console | administrators | organization, catalog, Agent fleet, access, provisioning, and later Channel/Skill governance | `/` |
| Agent UI | Agent users | accessible Agents, ACP Sessions, conversation, attachments, and Tool activity | `/workspace/` |

Admin Console remains a thin BFF. Adding a page does not transfer ownership of
the underlying record into the Console. Agent UI is not an administrator page
hidden inside the Console; the Console exposes an application-switch link now
that Edge Gateway serves the production Agent UI and ACP bridge.

Links to unfinished applications or pages stay absent. A disabled navigation
tree full of promised features is not useful product behavior.

The shared Console shell treats compact navigation as a real modal interaction
boundary rather than an off-screen visual transform. Closed navigation is not
keyboard reachable, opening it moves focus into the drawer, and both same-page
and cross-page navigation close it. Dismissal restores the menu trigger while a
selected destination receives main-content focus and starts at the top.

## Classification

### A. Split application

These workflows left Admin Console intentionally:

| Previous surface | Target | Current state | Integration rule |
| --- | --- | --- | --- |
| Chat | Agent UI | implemented through the production Edge-to-ACP v1 bridge | Console links to `/workspace/` |
| User-facing Agent selection | Agent UI | implemented through the authoritative principal-scoped bootstrap | Agent access subjects and internal ACP endpoints remain server-side |
| Session and conversation activity | Agent UI | implemented through ACP list/load/new/prompt/cancel | ACP remains the state authority |
| User-facing Run and Tool progress | Agent UI | implemented from ACP message and Tool updates | no second Console-owned Run model |

The old connection-settings page is removed rather than migrated. Browser
clients use same-origin Edge Gateway routes and must not configure internal
service base URLs or paste API tokens.

### B. Owner service pending

These are valid Admin Console areas, but their owner service is not yet ready.
They remain out of navigation until the service contract and BFF integration
exist.

| Surface | Owning service | Current state | Console action after delivery |
| --- | --- | --- | --- |
| Channels and Agent bindings | Channel Gateway | service pending | add Channel management pages backed only by Channel Gateway RPC |
| System Skills, versions, review, and distribution | Skill Registry | service pending | add Skill governance pages backed only by Skill Registry RPC |

Neither page may read another service's tables or temporarily store its domain
records in the Console.

### C. Implemented capability missing from Console

These are product defects. Their owner services and core commands already
exist, but the Stage 3A BFF or browser workflow exposes only part of them.

| Capability | Existing authority | Missing product closure |
| --- | --- | --- |
| Model capability catalog | Agent Controller owns the model adapter compatibility boundary and built-in metadata | implemented: safe BFF catalog projection, provider/model selection, authoritative limits for known models, and explicit custom-API fields only for unknown models |
| Model Profile revisions | Agent Controller supports organization-scoped get and revise | implemented: detail page, revise form, revision outcome, and BFF get/revise routes |
| Template revisions | Agent Controller supports organization-scoped get and revise | implemented: detail page, revise form, explicit model revision selection, and BFF get/revise routes |
| Organization Groups | Identity `list_directory` already returns Groups | implemented: searchable read-only Groups view with source and status |
| Local user administration | Identity supports create user, update membership, and activate/deactivate user | implemented: BFF commands, local create/edit, organization access, and system-admin global activation workflows |
| Current administrator account | Identity owns organization-scoped profile, Organization presentation, and credential facts | implemented: trusted-principal-only account summary, human-readable account and Organization context, section-local retry, and BFF removal of internal identity IDs |
| Local account security | Identity supports a current-user password change command | implemented: Identity-authoritative local-credential capability, trusted-principal-only BFF command, and an account dialog with write-only, non-persistent credential input |
| OIDC administration | Identity supports safe listing, upsert, and enable/disable | implemented: system-admin Provider list/create/edit/enable/disable, secret-free BFF projections, and immutable issuer guidance |
| SCIM credentials | Identity supports safe listing, issue, and revoke | implemented: organization-admin token list, one-time no-store credential issuance, and revocation UI |
| Enterprise login ingress | Identity supports login-method discovery, OIDC start/callback, and SCIM protocol resources | implemented: organization-aware SSO choices on login, server-side callback-to-cookie exchange, and Edge SCIM pass-through |
| Agent executable lineage | Agent Controller retains immutable AgentSpec and Execution revisions | implemented: detail-only safe projection, immutable Catalog revision reads, and revision-qualified Console links that remain exact after catalog heads advance |

OIDC and SCIM are not implemented as write-only forms. Identity Service exposes
explicit administrative reads that select no OIDC secret or SCIM token hash.
The Console does not infer configuration from login methods and retains a SCIM
credential only in page memory until the one-time issuance dialog is closed.
Their inventories fail independently: an unavailable OIDC read does not erase
SCIM administration, and an unavailable SCIM read does not erase OIDC
administration. Transient read failures have section-local retry actions. Mutation and
clipboard failures remain visible in the originating dialog without clearing
administrator input or persisting the one-time credential.

Independent resource reads retain structured failure semantics through the
browser state container. Model Catalog, Runtime defaults, referenced Model
revisions, account profile, OIDC/SCIM inventories, and paged Model/Template
selectors offer a local retry only for transient failures. Explicit
permission, missing-resource, and retention-terminal responses remain visible
without a button that would simply repeat an impossible request. Previously
loaded primary records and eligible selector options remain usable.

Directory and Provisioning lists use human business identity as their primary
language. Organization IDs are request scope and never browser response data;
read-only Group database IDs and OIDC record IDs are also removed by the BFF.
The stable OIDC Provider name remains visible because it is part of external
configuration. A SCIM token ID remains an opaque revoke-action handle but is
not displayed as the credential's name or subtitle.

Provisioning changes are operational: an enabled OIDC Provider appears as an
organization login choice, and an Identity-issued SCIM credential is accepted
at Edge `/scim/v2`. Edge consumes the one-time OIDC access token into HttpOnly
cookies and never exposes it to Console JavaScript. SCIM Bearer authorization
is preserved while browser cookies and forged principal headers are removed.
The Provisioning surface displays the exact public OIDC callback and SCIM base
addresses wherever the administrator configures the corresponding external
system. Both are derived from the same-origin Edge location rather than an
editable internal URL; copy failures leave the address visible for retry. The
one-time SCIM dialog keeps its base URL beside the credential so completing the
external connector does not depend on hidden deployment knowledge.

The account area obtains the signed-in principal's display name, email, source,
Organization name and slug, and local-password capability from an
Identity-owned current-account query. The BFF uses internal User, Membership,
and Organization IDs only to bind that query, then strips them from its browser
DTO. The global shell and Directory description therefore present a human
Organization context and do not fall back to displaying an opaque ID. The UI
also does not infer credential ownership from Membership source or from browser
session fields. If that optional profile read is unavailable, the Console keeps
the authenticated application usable, shows a local retry, uses neutral
account/Organization labels, and hides the password action until Identity
explicitly confirms that a local credential exists.

Self-service password rotation targets only the signed-in principal. It does
not accept a target User from browser JSON, retain password fields in retry
storage, or become a general credential administration page. External identity
credentials remain owned by the configured identity provider. Rejecting the
submitted current password is an account-operation error and does not discard
the otherwise valid Edge browser session.

Agent lifecycle management, durable operation tracking, and per-Agent event
history are already part of Stage 3A. The Fleet defaults to current Agents;
deleted records are available only through the explicit `Deleted` audit view,
where their detail and event history are read-only. Lifecycle actions are
offered only when the authoritative desired/lifecycle state satisfies the
Agent Controller command precondition. Missing presentation polish in those
flows is handled as an ordinary page defect, not as a new domain service.
Deleting an Agent requires an in-product confirmation that distinguishes
Runtime/workspace removal from retained Agent and lifecycle evidence. While a
focused mutation is awaiting admission, its dialog cannot be dismissed; after
an asynchronous lifecycle command is accepted, progress moves to the Agent's
authoritative operation and event surfaces.
Agent projection and lifecycle-event history fail independently. A history
outage cannot replace an otherwise readable Agent, immutable executable
configuration, or valid lifecycle action with a page-level error. The event
section retains already loaded evidence and offers its own authoritative retry
only for a transient failure. A terminal permission, missing-resource, or
retention response remains visible without a retry and stops automatic replay.
Active operation progress is another independent read. If it is unavailable,
the Agent remains readable and its active request still closes conflicting
actions; the operation section names the failure and retries locally only when
the failure is transient. A stale operation from an older request is hidden
rather than presented as current. Owner Directory resolution and later Agent
refreshes follow the same structured rule while preserving any loaded human
identity or Agent projection. A failed Agent refresh closes lifecycle commands
that would otherwise rely on stale command preconditions. A terminal Operation
failure is not fetched again automatically until the Agent names a new active
request.
Stream recovery preserves those same boundaries. Event replay commits its own
history and cursor and reopens the watch independently of Agent refresh. Agent
refresh commits lifecycle state independently of replay. Their errors and
retries remain local, replay retry does not create repeated Agent traffic, and
a terminal replay failure cannot create an unbounded recovery loop.
The active request on the refreshed Agent wins operation selection; an idle
Agent uses the newest operation-bearing replayed event. Concurrent Agent reads
converge by aggregate sequence, so completion order cannot regress state or
discard the only valid initial snapshot.
Agent detail also renders the executable configuration frozen by the latest
published lifecycle operation. It does not infer lineage from current catalog
heads, and it does not expose Provider credentials or Runtime routing facts.
Template and Model links carry the immutable revision identity. Historical
detail is read-only and continues to resolve after newer Catalog revisions are
published; current names remain presentation labels rather than revision
authority.
Revision-qualified Model and Template routes read the requested immutable
revision directly and do not make current-head availability a prerequisite.
The Model revision referenced by a Template is an independent presentation
dependency: lookup failure cannot erase the Template's prompt, Runtime policy,
or revision facts, and is recovered through a section-local retry.
Primary detail failures retain their HTTP meaning instead of collapsing into a
generic retry state. Model, Template, and Agent reads offer retry only for a
transient failure. A missing or no-longer-retained resource and an explicit
permission denial keep a path back to the corresponding inventory without
inviting the administrator to repeat a request that cannot succeed.
The same rule applies to the primary Model, Template, Agent, and Directory
inventories. A later refresh failure preserves an already loaded snapshot.
Agent current and deleted inventories remain independent reads, so a terminal
failure in retained-record access neither erases nor disables the current Fleet.

Agent Fleet keeps machine identity as diagnostic evidence rather than primary
page language. Inventory rows lead with Agent name, owner, lifecycle state, and
update time. Desired state is shown only while it differs from the converged
lifecycle state. Exact Agent, Runtime, and Execution revision identifiers are
available from a default-collapsed technical section on Agent detail; event
trace IDs follow the same progressive-disclosure rule. This preserves support
and audit correlation without making an administrator decode opaque IDs during
ordinary fleet work.

Owner eligibility and owner presentation are separate concerns. New Agent
forms offer only Users whose global account and Organization Membership are
both active; current and deleted inventory resolves names from all retained
Directory records. Disabling a person therefore prevents new assignment
without replacing the owner of existing audit evidence with `Owner
unavailable`.

Model Profile, Template, and Agent inventories use bounded owner-service
pagination. The BFF forwards only the documented opaque cursor and bounded page
size while injecting organization scope from the trusted principal. The
browser merges pages by resource identity, keeps loaded rows when a later page
fails, and labels search results as a match within loaded data. The deleted
Agent view is filtered by Agent Controller rather than fetched as a mixed list
and filtered in the browser.

Inventory presentation is viewport-aware without changing its authority or
commands. Wide screens retain dense tables; narrow screens render complete
resource summaries for Agents, Model Profiles, Templates, directory entries,
OIDC Providers, and SCIM credentials. Status, identity, essential operating
facts, and available row actions remain visible without horizontal scrolling.

Administrative forms expose the same semantic structure across those
surfaces. A field label is the control's concise accessible name, while
supporting constraints and examples are linked through `aria-describedby`.
Help text is therefore available without becoming a repeated, oversized label
for every text box or selector. Dynamic failures are assertive announcements;
ordinary loading and successful completion are polite announcements. Only the
control that owns an active request is marked busy.

Dependency selectors obey the same boundary. Template create/revise can
incrementally traverse Model Profile pages, while Agent create/rebuild can
traverse Template pages. Disabled rows are omitted from choices but do not
erase the owner cursor. Consequently an eligible-empty first page with a
continuation remains navigable instead of disabling the workflow as though the
entire Catalog were empty. A later-page failure preserves loaded choices and
its structured retryability instead of degrading into an untyped string.

Overview uses the same bounded owner-service pages. It is an operational
snapshot, not a cross-service analytics query: continuation cursors are
preserved, counts become explicit lower bounds while another page exists, and
Agent lifecycle distributions describe only loaded records. The Console never
labels the first page as an organization total or calls the owner service's
creation-order page "recent".
Optional dependency failures retain their business-resource name while hiding
upstream transport details, so the administrator can identify what needs a
retry instead of seeing repeated generic section errors. Active member totals
require both the User and its Organization Membership to be active; retained
disabled Directory records are not reported as launch-ready owners.

The core setup path is now an explicit derived view rather than tribal
knowledge: connect one Model Provider, create one Agent Template, ensure an
active Directory owner exists, then create an Agent. The Console derives each
step from the existing owner-service projections; it stores no wizard state and
does not require the administrator to finish one page before visiting another.
An unavailable owner service remains visibly different from an empty catalog,
and every retryable load failure exposes a retry action. If a partial Catalog
page contains no enabled resource, setup guidance asks the administrator to
review the remaining records instead of claiming the prerequisite is absent.
Empty states and disabled create actions link directly to the missing
prerequisite.

The cross-service Overview aggregate belongs only to the Overview page.
Model Profile inventory and immutable detail remain readable when the
release-managed capability Catalog is unavailable; only connect/revise actions
wait for Catalog recovery. Template inventory loads Templates, Model choices,
and the presentation-owned Runtime default independently; Agent inventory loads
Agents, Template choices, and Directory owners independently. A failed
dependency disables only the creation or revision path that needs it, preserves
the primary inventory, and provides its own retry. Resource pages do not issue
an Overview request or duplicate their primary owner query.

### D. Ownership not decided

These concepts remain outside implementation until their authority and
failure semantics are explicit.

#### Scheduled Tasks

No page or API is added yet. Three materially different owners remain under
consideration:

1. Agent ACP Service initiates work from Session/Run semantics.
2. Agent Controller initiates work as part of Agent lifecycle and admission.
3. A separate Scheduler Service owns schedules and invokes the execution path.

Choosing a navigation item before choosing the durable schedule owner would
only preserve the monolith's ambiguity.

#### Cross-service Audit And Events

Agent Controller remains authoritative only for Agent domain events. Identity
Service retains Identity audit facts, Runtime Controller retains Runtime
observations, and ACP Service retains Session/Run facts. Agent Controller is
not silently promoted into a generic platform event bus.

The platform-wide audit surface requires a separate decision between:

- an explicit cross-service audit projection owned by a future Audit Service;
- bounded aggregation of owner-service read APIs for a small administrator
  view;
- retaining operational detail only in OTLP backends while exposing no unified
  product audit page.

Until that decision is made, the Console may display domain-local evidence on
the owning resource page, but it must not label Agent events as a complete
system audit trail. A generic System/Audit/Event page is therefore deferred.

## Delivery Order

The convergence work is intentionally ordered by existing authority, not by
the old sidebar position.

1. **Catalog closure (implemented)**: authoritative model presets, Model
   Profile and Template get/revise BFF contracts, details, edit flows, and
   contract/browser tests. Known model limits are maintained by Agent
   Controller; only custom OpenAI-compatible APIs ask administrators for
   endpoint and capability metadata.
2. **Directory closure (implemented)**: Groups display, local-user creation,
   membership role/profile updates, organization access, and system-admin User
   activation controls.
3. **Enterprise provisioning closure (implemented)**: secret-free OIDC
   Provider and SCIM token list contracts, Console management, organization
   SSO discovery/callback, public SCIM ingress, and one-time credential handling.
4. **Agent workspace integration (implemented)**: Edge Gateway `/workspace/`
   application, authenticated ACP bridge, authoritative Agent bootstrap, and
   Console application-switch link.
5. **Agent Fleet convergence (implemented)**: explicit current/deleted views,
   read-only retained records, human-readable owner projection, failure
   evidence, command gating, and authoritative SSE recovery.
6. **First-run convergence (implemented)**: one stateless setup projection over
   Model, Template, Directory, and Agent authority, with actionable empty,
   blocked, unavailable, and retry states.
7. **Agent lineage convergence (implemented)**: exact executable Template and
   Model revisions, revision-qualified historical Catalog deep links, frozen
   policy, and Runtime input on Agent detail, projected without credentials or
   internal endpoints.
8. **Inventory traversal (implemented)**: bounded cursor traversal for Model,
   Template, current Agent, and deleted Agent inventories, with page-local retry
   and identity-based de-duplication.
9. **New owner services**: Channel and Skill pages only after their services
   and RPC contracts are implemented.

Scheduled Tasks and platform-wide Audit/Event are not hidden work inside these
increments.

## Acceptance Rules

A migrated surface is complete only when:

1. its owning service exposes the required authoritative command and query;
2. the BFF shapes an explicit browser DTO and supplies actor/organization
   authority from the trusted session;
3. the UI supports loading, empty, explicit success acknowledgement, retryable
   failure, and forbidden states without inventing domain state or offering a
   retry for terminal `403`/`404`/`410` responses; synchronous
   administrator mutations use persistent dismissible feedback, while Agent
   lifecycle operations and SCIM issuance use their authoritative state/event
   and one-time credential surfaces;
4. secrets and internal identifiers remain outside browser responses, logs,
   and traces;
5. contract, service, browser-component, and applicable disposable-stack tests
   prove the workflow;
6. this matrix and the affected business sequence are updated.
