# Product Surfaces And Feature Convergence

This document describes which browser application owns each product workflow
and the rules each Console surface follows.

It separates four situations that otherwise look identical in the browser: a
feature intentionally moved to another application, a feature whose owner
service does not exist yet, an implemented domain capability that the Console
failed to expose, and a product concept whose ownership is still undecided.
Only the third case is a Console defect.

An earlier monolithic product serves as a feature inventory, not the target
navigation model. The platform restores useful workflows without recreating its
service coupling or presenting unavailable controls.

The [Stage 4 services document](stage-4-services.md) describes Skill Registry,
Channel Manager and Task Scheduler. Skill Registry has a
[minimal technical design](skill-registry-minimal-design.md) and an implemented
[service](../services/skill-registry/README.md). The
[Admin Console Skills module](../services/admin-console/docs/skills.md) covers
publication, inventory, fixed-version Template selection, Agent preparation
progress, search and preview of Skills from the administrator's own Agents, and
explicit promotion to a formal Skill. Publication, Template selection and
rebuild remain separate user actions. Channel Manager and Task Scheduler are not
implemented. Cross-service audit ownership remains undecided, and trace
collection does not introduce an audit service.

## Product Boundary

Antnest has two browser applications:

| Application   | Audience       | Owns the experience                                                                          | Stable entry  |
| ------------- | -------------- | -------------------------------------------------------------------------------------------- | ------------- |
| Admin Console | administrators | organization, catalog, Agent fleet, access, provisioning, and later Channel/Skill governance | `/`           |
| Agent UI      | Agent users    | accessible Agents, ACP Sessions, conversation, attachments, and Tool activity                | `/workspace/` |

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

| Previous surface                  | Target   | Current state                                                            | Integration rule                                                                     |
| --------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Chat                              | Agent UI | Session-first workspace through the production Edge-to-ACP bridge        | Console may deep-link to `/workspace/?agent=<id>`                                    |
| User-facing Agent selection       | Agent UI | explicit chooser and principal-scoped bootstrap with management metadata | ACP owns execution availability and resource authorization; no opaque access subject |
| Session and conversation activity | Agent UI | implemented through ACP list/load/new/prompt/cancel                      | ACP remains the state authority                                                      |
| User-facing Run and Tool progress | Agent UI | implemented from ACP message and Tool updates                            | no second Console-owned Run model                                                    |

The old connection-settings page is removed rather than migrated. Browser
clients use same-origin Edge Gateway routes and must not configure internal
service base URLs or paste API tokens.

### B. Stage 4 owner surfaces

Registry inventory and publication are in Console navigation; Template forms
and Agent lifecycle dialogs consume the Controller and Runtime preparation
workflow.

| Surface                              | Owning service                      | Current state                           | Console rule                                                      |
| ------------------------------------ | ----------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Channels and Agent bindings          | Channel Manager (`channel-manager`) | Planned; service not implemented        | add Channel management pages backed only by Channel Manager RPC   |
| Hosted Skills and immutable versions | Skill Registry (`skill-registry`)   | Console BFF and Skills page implemented | Template selection and Agent rebuild remain Controller operations |

Neither surface may read another service's tables or temporarily store its domain
records in the Console. Task scheduling belongs to Task Scheduler; its UI entry
and interaction design remain pending as described below.

The [minimal Skill Registry design](skill-registry-minimal-design.md) distinguishes
published packages, Agent-selected versions, Runtime-applied artifacts and Run
usage. Pages present these outcomes separately. Agent selection
and explicit application use Agent Controller operations; a Registry download
is not evidence that an Agent has installed or used the Skill.
The Console supports upload/version lists, explicit Template version selection,
and configured system Skills. Preparation progress/retry is separate from
lifecycle change and Runtime readiness; rebuilding Agents keep their current
execution available until preparation has succeeded, including during a
Registry outage. Cross-catalog search, imports and review workflows are not
implemented. Runtime presets are read-only; Console has no in-place editor for
installed packages.

The separate [learning design](skill-learning-design.md) makes automatic
generation/updates of managed personal Skills its primary flow. Agent UI shows
applied-change notices, result history and source links. A paused-review diagnostic
is read only when results open. Controller owns the learning policy and pins;
there is no UI policy editor, undo, diff view or retained versions.
Normal automatic application needs no per-change approval and also works with
the browser closed.
The [notification design](skill-learning-notifications-design.md) uses SDK 1.5.0's
`notice` as the live channel, with namespaced metadata linking persisted learning
changes. Server owns durable results and publication recovery; Node Bridge owns
reconciliation and existing workspace SSE projections; the frontend deduplicates
and restores those views. Bounded history reads support recovery, not a parallel
long-poll notification channel. These remain display items outside model history
and Run process groups; the SDK capability remains experimental but is wired
on both ACP and Node.
Manual "Save as Skill" is a planned optional entry, with authenticated source
selection and exact-content confirmation for that manual branch. Model text
cannot manufacture user actions or change the maintenance policy.

Ordinary learning deferral has no permanent banner or diagnostic polling.
The on-demand results panel shows a bounded reason; for background writes it
suggests optionally asking the Agent to stop its task through a normal Run.
It adds no task-management view, kill API or stop button. Waiting maintenance
releases its execution slot and rechecks task/descendant exit and candidate
content before applying. It never automatically kills a dev server.
Personal-to-system publication still requires manual export and administrator
upload; automatic learning does not publish to the organization.

### C. Delivered Console Workflows

These workflows close gaps left when the administrator and end-user
applications were split. The table describes current ownership.

| Capability                            | Existing authority                                                                              | Current product surface                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model discovery and defaults          | Console owns builtin defaults and remote discovery; Controller owns saved organization models   | merged candidates, explicit selection, editable limits/capabilities/pricing, existing values preserved                                                                      |
| Current Model Profiles                | Controller stores current configuration; no separate model-history API                          | current detail/edit, model enable/disable with reference protection; credentials managed on connections                                                                     |
| Provider availability and fallback    | Controller owns connection/configuration; ACP owns effective selection and client revocation    | referenced Provider disable, ordered Template backup models, live ACP configuration and fallback notices                                                                    |
| Template revisions                    | Controller owns immutable revisions referencing stable model identities                         | revision detail/publication, default and ordered backup model selection, separate current-template enablement                                                               |
| Organization Groups                   | Identity `list_directory` already returns Groups                                                | implemented: searchable read-only Groups view with source and status                                                                                                        |
| Local user administration             | Identity supports create user, update membership, and activate/deactivate user                  | implemented: BFF commands, local create/edit, organization access, and system-admin global activation workflows                                                             |
| Current administrator account         | Identity owns organization-scoped profile, Organization presentation, and credential facts      | implemented: trusted-principal-only account summary, human-readable account and Organization context, section-local retry, and BFF removal of internal identity IDs         |
| Local account security                | Identity supports a current-user password change command                                        | implemented: Identity-authoritative local-credential capability, trusted-principal-only BFF command, and an account dialog with write-only, non-persistent credential input |
| OIDC administration                   | Identity supports safe listing, upsert, and enable/disable                                      | implemented: system-admin Provider list/create/edit/enable/disable, secret-free BFF projections, and immutable issuer guidance                                              |
| SCIM credentials                      | Identity supports safe listing, issue, and revoke                                               | implemented: organization-admin token list, one-time no-store credential issuance, and revocation UI                                                                        |
| Enterprise login ingress              | Identity supports login-method discovery, OIDC start/callback, and SCIM protocol resources      | implemented: organization-aware SSO choices on login, server-side callback-to-cookie exchange, and Edge SCIM pass-through                                                   |
| Agent executable lineage              | Controller retains immutable AgentSpec and Execution revisions                                  | frozen build details and exact Template revision links; model links open current settings without changing the build snapshot                                               |
| Execution history and synchronization | ACP owns execution audit; Controller owns configuration synchronization receipts                | independent audit page, deleted-Agent history and separate stored publication acknowledgement                                                                               |
| Runtime image presentation            | Runtime Controller resolves installed images; Agent Controller freezes executable configuration | implemented: default/current image or explicit repository/tag selection, server-derived readable labels, and immutable publication                                        |

OIDC and SCIM are not implemented as write-only forms. Identity Service exposes
explicit administrative reads that select no OIDC secret or SCIM token hash.
The Console does not infer configuration from login methods and retains a SCIM
credential only in page memory until the one-time issuance dialog is closed.
Their inventories fail independently: an unavailable OIDC read does not erase
SCIM administration, and an unavailable SCIM read does not erase OIDC
administration. Transient read failures have section-local retry actions. Mutation and
clipboard failures remain visible in the originating dialog without clearing
administrator input or persisting the one-time credential.

A successful administrative command and its subsequent inventory refresh are
separate outcomes. The success acknowledgement survives a failed refresh; it
must not invite the user to submit the successful command again. Directory
records remain readable during refresh and after failure, but their edit and
global-access actions require a successfully refreshed snapshot. Pending
Directory writes also close new dialog entry points. OIDC row editing cannot
start while another Provider change is pending. SCIM issuance keeps its
one-time credential accessible even when refreshing the token inventory fails.

Independent resource reads retain structured failure semantics through the
browser state container. Model Catalog, Runtime defaults, referenced current
Models, account profile, OIDC/SCIM inventories, and paged Model/Template
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
Component tests cover validation before transport, pending-action gating,
rejected input retention, explicit retry, confirmed success, and credential
clearing on dismissal, using synthetic HTTP fixtures.

Sign-out is also an authoritative remote operation. Console keeps the current
page while Edge revokes the session and clears its cookies; the pending action
cannot be submitted twice. Only confirmed success or an authoritative session
expiration opens the login page. A rejected or unreachable sign-out remains
visible beside the account controls without claiming that the session ended.
Ending a session also closes its navigation drawer and account dialog, so a
subsequent login does not inherit those interactions.
The initial session read follows the same structured failure policy as resource
pages. An absent or expired session (`401`) opens login; `403`, `404`, and `410`
show terminal access/missing-service feedback without a retry loop. A transient
failure offers an explicit, single-flight session-read retry while preserving
the failure message. This retry does not reload the document or load protected
resources before authentication succeeds.

Agent lifecycle management, durable operation tracking, and per-Agent event
history are part of the administrator control plane. The Fleet defaults to current Agents;
deleted records are available only through the explicit `Deleted` audit view,
where their detail and event history are read-only. Reading a completed
deletion, including its arrival through live events, leaves the retained detail
open; navigation back to the Fleet is an explicit user action. The operation
section is `Current operation` only while the Agent names an active request;
otherwise it is `Last operation`. A phase identical to the operation state is
not rendered as a duplicate status, while a distinct failed phase remains
visible for diagnosis.
Lifecycle actions are offered only when the authoritative desired/lifecycle state satisfies the
Agent Controller command precondition. Missing presentation polish in those
flows is handled as an ordinary page defect, not as a new domain service.
Deleting an Agent requires an in-product confirmation that distinguishes
Runtime/workspace removal from retained Agent and lifecycle evidence. While a
focused mutation is awaiting admission, its dialog cannot be dismissed; after
an asynchronous lifecycle command is accepted, progress moves to the Agent's
authoritative operation and event surfaces.
Lifecycle command admission and the subsequent Agent read are separate results.
An accepted request receives an explicit acknowledgement, not a claim that the
operation has completed. A failed follow-up read cannot turn that receipt into
a command failure or invite resubmission. It preserves the last readable Agent
and closes lifecycle actions until an authoritative read succeeds, including
while a retry is pending. A rejected rebuild keeps its selected Template and
error inside the originating dialog; canceling and reopening clears that error.
Agent detail component state is scoped to the Agent identity: changing that
identity discards the previous Agent's dialogs and command feedback rather
than carrying a pending form or late response into another Agent.
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
history and cursor, then awaits one Agent refresh before reopening the watch.
A refresh failure stays local and does not prevent reopening. This ordering
captures lifecycle changes missed before replay without coupling successful
projection updates. Their errors remain local, failed replay retries do not create repeated Agent traffic, and
a terminal replay failure cannot create an unbounded recovery loop.
The active request on the refreshed Agent wins operation selection; an idle
Agent uses the newest operation-bearing replayed event. Concurrent Agent reads
converge by aggregate sequence, so completion order cannot regress state or
discard the only valid initial snapshot.
Agent detail also renders the executable configuration frozen by the latest
published lifecycle operation. It does not infer lineage from current catalog
heads, and it does not expose Provider credentials or Runtime routing facts.
Template links carry the immutable revision identity; historical Template detail
is read-only and remains available after later publication. Model links open
current settings. The Agent's immutable build snapshot preserves the model
parameters used for that build; it does not require a Model history API.
A Template's referenced current Model is an independent presentation dependency:
lookup failure cannot erase the Template's prompt, Runtime policy or revision
facts, and is recovered through a section-local retry.
Runtime image selection is a product-level choice, not a digest editing task.
Normal Template creation uses the platform default; revision keeps that
Template's pinned image instead of adopting a changed deployment default.
An explicit image choice uses a repository and tag. The published executable
configuration still needs a resolved immutable image identity, so updating a
tag later cannot silently change the environment represented by a Template
revision. Digest resolution belongs to the image/platform owner, not a browser
request or a Docker client inside the Console BFF. Exact digests remain internal
configuration and audit data, not Console form inputs or image labels.
Without a configured default, Console requires an explicit tag rather than
blocking creation. Existing Templates remain readable and revisable. Resolved
images carry a server-derived human source; a bare immutable ID without that
metadata is called `Platform runtime` without inventing a tag.
The owner-side resolution query, Agent Controller publication, and Console tag
choice are wired together. There is no image registry, image builder, or
implicit pull. Agent Controller resolves a chosen repository/tag
only after replay and reference scope checks, then freezes both the immutable
image and its human source in the
Template revision. A command replay returns the original pin even when the tag
moves or the resolver is unavailable. Editing other Template fields preserves
the previous pin; selecting a different image is an explicit action. Console
continues to own only form presentation and safe DTOs, not Docker access.
An unavailable tag is rejected without publication.
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
Later-page failures retain structured status just like initial reads: terminal
responses stop traversal without erasing loaded records; transient failures
retry the same cursor only on an explicit action. Pending traversal disables
duplicate requests. Current and Deleted Agent cursors and failures stay local
to their view. A failed initial Deleted read is not an invitation for the mount
effect to retry; returning to that tab preserves the failure until an explicit,
permitted retry or a new page visit.

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

Overview failures preserve the same terminal/transient distinction as resource
pages. A required Agent inventory failure preserves its safe HTTP status;
optional section errors include a safe `status`, `code`, and resource-named
`message`. The page lists these failures without treating every degraded section
as retryable. Refresh is offered only when at least one failure is transient;
a terminal aggregate failure suppresses refresh of any older degraded snapshot.
Refresh keeps previously loaded data visible and disables duplicate requests.
Unmounting cancels the pending aggregate read and ignores late completion.

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

Catalog creation retries are one logical administrator action. Model and
Template forms submit only editable values; the BFF derives their resource key
from the organization-scoped idempotency request ID. It rejects client-supplied
`profile_key`/`template_key`. A lost response or transient HTTP failure therefore
retains the same body, command ID, and resource key on retry. After confirmed
success, another creation receives a fresh identity even for identical values.
Generated Catalog keys stay inside the BFF/owner boundary and are not returned
or displayed in the Console; names, resource IDs, and revisions already support
the administrator's navigation and configuration workflow.
The Agent Controller request ledger remains the durable replay authority. Form
fields and credentials are never persisted for recovery; the existing browser
retry store contains only opaque request identifiers and input fingerprints.

### D. Planned Or Undecided Work

These concepts remain outside implementation until their authority and
failure semantics are explicit.

#### Scheduled Tasks

No page or API exists yet. Task Scheduler (`task-scheduler`) is the planned
initiator of scheduled Agent usage. It will own schedules and trigger records,
while Agent Controller retains configuration/lifecycle and ACP Service retains
admission/execution. Execution identity, Session reuse, overlap, and missed-fire
policy remain future design decisions. The
[Stage 4 services document](stage-4-services.md) records the current scope.

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
system audit trail. Console's implemented Execution history page reads only
ACP-owned execution audit; it is not a generic cross-service audit service.
A unified System/Audit/Event surface remains deferred.

## Convergence Summary

Console workflows are grouped by existing authority, not by an old sidebar
position:

1. **Catalog**: authoritative model presets, Model Profile and Template
   get/revise BFF contracts, details and edit flows. Console maintains builtin
   defaults and discovers remote candidates; Controller persists explicitly
   selected model settings. DeepSeek and OpenRouter connections expose editable
   limits and capabilities.
2. **Directory**: Groups display, local-user creation, membership role/profile
   updates, organization access, and system-admin User activation controls.
3. **Enterprise provisioning**: secret-free OIDC Provider and SCIM token list
   contracts, Console management, organization SSO discovery/callback, public
   SCIM ingress, and one-time credential handling.
4. **Agent workspace**: Edge Gateway `/workspace/` application, authenticated
   ACP bridge, authoritative Agent bootstrap, and Console application-switch
   link.
5. **Agent Fleet**: explicit current/deleted views, read-only retained records,
   human-readable owner projection, failure evidence, command gating, and
   authoritative SSE recovery.
6. **First run**: one stateless setup projection over Model, Template,
   Directory, and Agent authority, with actionable empty, blocked, unavailable,
   and retry states.
7. **Agent lineage**: exact executable Template revision, frozen model
   parameters, historical Template and current-model links, frozen policy, and
   Runtime input on Agent detail, projected without credentials or internal
   endpoints.
8. **Inventory traversal**: bounded cursor traversal for Model, Template,
   current Agent, and deleted Agent inventories, with page-local retry and
   identity-based de-duplication.
9. **New owner services**: Channel pages are added only after Channel Manager
   and its RPC contract are implemented.

Scheduled Tasks and platform-wide Audit/Event are not hidden work inside these
groups.

## Completion Rules

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
6. this document and the affected flow description are updated.

Channel pages wait for their owner service. Task Scheduler is planned, and
cross-service Audit remains undecided.
