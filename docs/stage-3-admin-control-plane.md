# Stage 3A Administrator Control Plane

> Status: administrator workflow implemented; acceptance remains scoped by batch
> Updated: 2026-09-17. Latest execution/workspace evidence: [current status](current-status.md).

Stage 3A adds the first supported browser entry to Antnest Platform. It connects
one administrator from login through Agent lifecycle management without moving
Identity or Agent business rules into the presentation tier.

Stage 3A delivered two services:

- **Edge Gateway** is the sole externally reachable application service. It
  terminates browser trust, resolves Identity credentials, enforces coarse
  administrator access, removes spoofable identity headers, and propagates
  trace context. Replica-local source/account login limits protect password
  verification; general-purpose and shared rate limiting remain deferred.
- **Admin Console** serves the React administrator application and a thin BFF.
  The BFF translates page commands into existing Identity Service and Agent
  Controller management RPCs and ACP audit reads. It owns no durable business records.

The implemented Stage 3 surface also includes **Agent UI** behind Edge Gateway.
Service and Docker tests cover ACP v1 Session, Tool activity, attachment,
cancellation and replay paths without moving Agent execution into the browser.
The original five [C4](docker-single-node-closeout.md) browser checks were
explicitly deferred in the 2026-09-11 closeout. Subsequent model selection,
Provider fallback and discovery have targeted real-browser evidence; the full
development-browser profile retains its strict Trace failure. See [current status](current-status.md).
Channel Gateway and Skill Registry remain outside this stage.

## Service Boundaries

### Edge Gateway owns

- the public HTTP listener and public route table;
- browser session cookie policy;
- access-token resolution through Identity Service;
- system/organization administrator admission for `/api/admin/*`;
- trusted identity-header construction and incoming-header sanitization;
- request size, dependency timeout, security-header, and trace policy;
- public forwarding of the Admin Console application.

It has no database and must not implement Identity, Agent, Runtime, Template,
or ModelProfile state transitions.

### Admin Console owns

- administrator page state, forms, navigation, and presentation models;
- UI-oriented request shaping and response aggregation;
- organization scoping derived from the trusted principal;
- forwarding lifecycle event streams without making them authoritative.

It has no database and never reads another service's tables. For model discovery,
the BFF resolves current Provider credentials through an organization-scoped
Controller internal endpoint, or uses an unsaved draft credential. These values
never return to the browser or enter telemetry. See [model discovery](model-discovery.md).
Browser command identities are retained across retries and forwarded to the
owning service; they are not Console business records.

## Trust And Session Model

1. The browser submits organization slug, email, and password only to
   `POST /api/session/login` on Edge Gateway.
2. Edge Gateway calls Identity Service `local_login` and stores the returned
   opaque access token in an `HttpOnly`, `SameSite=Lax` cookie. The token is
   never returned in a browser JSON response or logged.
3. Every protected request resolves the token through Identity Service.
   Inactive, expired, revoked, or unknown tokens fail closed.
4. `/api/admin/*` requires either `system_role=admin` or
   `organization_role=admin`.
5. Edge Gateway removes the known trusted identity/access-subject headers before
   injecting verified values. `X-Antnest-Expected-Principal` is a browser command
   precondition, not an authentication claim, and remains available for checking.
6. Logout expires cookies after confirmed revocation or an already-invalid
   token; absent local session cookies are also cleared. Identity failure returns
   `503` without clearing a valid local session. Failed CSRF rejects the request.

The trusted headers are:

```text
X-Antnest-User-ID
X-Antnest-Organization-ID
X-Antnest-Membership-ID
X-Antnest-System-Role
X-Antnest-Organization-Role
```

They are an internal transport projection, not a new identity model. Admin
Console is reachable only from the trusted deployment network.

## Public Route Surface

| Route | Authentication | Owner |
| --- | --- | --- |
| `GET /status` | none | Edge Gateway readiness |
| `POST /api/session/login` | none | Edge Gateway + Identity RPC |
| `POST /api/session/login-methods` | none | Edge Gateway + Identity RPC |
| `POST /api/session/oidc/start` | none | Edge Gateway + Identity RPC |
| `GET /protocol/oidc/callback` | OIDC state and authorization result | Edge Gateway + Identity protocol |
| `/scim/v2/*` | SCIM Bearer credential | Identity protocol through Edge Gateway |
| `GET /api/session` | browser session | Edge Gateway |
| `DELETE /api/session` | browser session when resolvable | Edge Gateway + Identity RPC |
| `/api/admin/*` | administrator session | Admin Console BFF through Edge Gateway |
| `GET /api/app/bootstrap` | browser session | Edge Gateway + Agent Controller |
| `GET /api/app/agents/{agent_id}/state` and `/state/watch` | browser session and Agent access | ACP snapshot/SSE through Edge Gateway |
| `/api/app/agents/{agent_id}/v1/acp` and `/acp` | browser session and Agent access | ACP v1 WebSocket or POST/GET SSE/DELETE HTTP |
| `/api/app/agents/{agent_id}/v2/acp` | browser session and Agent access | ACP v2 WebSocket |
| `/workspace/` and application assets | static entry; data requests require session | Agent UI through Edge Gateway |
| unmatched non-API/non-protocol `GET`/`HEAD` paths | none | Admin Console application/assets |

The public surface is a product API for the Console, not the future stable
third-party OpenAPI. OIDC callback and SCIM ingress remain Identity-owned
protocol surfaces routed by Edge; they do not become Console BFF resources.

`GET /api/admin/overview` is a bounded operational snapshot. Its Model Profile,
Template, and Agent sections retain owner-service continuation cursors. Counts
are exact only when the corresponding cursor is absent; otherwise Console
renders a lower bound and scopes lifecycle distributions to the loaded page.
Overview does not perform unbounded fan-out merely to manufacture fleet totals.

Template create/revise and Agent create/rebuild selectors load their Model
Profile or Template dependencies incrementally through the same opaque Catalog
cursor. They retain already loaded eligible choices after a later-page failure,
offer an in-form retry, and never infer global absence from a partial page.

## Admin Console BFF Surface

The BFF retains the Stage 3A management path and includes the first catalog
convergence extension:

```text
GET    /api/admin/overview
GET    /api/admin/template-defaults
GET    /api/admin/account
POST   /api/admin/account/password
GET    /api/admin/directory
POST   /api/admin/directory/users
POST   /api/admin/directory/memberships/{membership_id}
POST   /api/admin/directory/users/{user_id}/active
GET    /api/admin/provisioning/oidc-providers
POST   /api/admin/provisioning/oidc-providers
POST   /api/admin/provisioning/oidc-providers/{name}/enabled
GET    /api/admin/provisioning/scim-tokens
POST   /api/admin/provisioning/scim-tokens
POST   /api/admin/provisioning/scim-tokens/{token_id}/revoke
GET    /api/admin/model-catalog
GET    /api/admin/model-profiles
POST   /api/admin/model-profiles
GET    /api/admin/model-profiles/{model_profile_id}
GET    /api/admin/model-profile-revisions/{revision_id}
POST   /api/admin/model-profiles/{model_profile_id}/revisions
GET    /api/admin/templates
POST   /api/admin/templates
GET    /api/admin/templates/{template_id}
GET    /api/admin/templates/{template_id}/revisions/{revision}
POST   /api/admin/templates/{template_id}/revisions
GET    /api/admin/agents
POST   /api/admin/agents
GET    /api/admin/agents/{agent_id}
GET    /api/admin/agents/{agent_id}/network-policy
PUT    /api/admin/agents/{agent_id}/network-policy
POST   /api/admin/agents/{agent_id}/{rebuild|disable|enable|delete}
GET    /api/admin/operations/{request_id}
GET    /api/admin/agents/{agent_id}/events
GET    /api/admin/agents/{agent_id}/events/watch
```

The Model Profile and Template list routes accept only `after_id` and `limit`.
The Agent list accepts only `view=current|deleted`, `cursor`, and `limit`.
List limits default to 100 and cannot exceed 100. Unknown or repeated query
parameters fail closed. Every route injects organization scope from the trusted
principal; `view=deleted` becomes an authority-side deleted lifecycle filter,
not a browser-side scan of mixed current and retained records.

`GET /api/admin/overview` is consumed only by the Overview page. Template and
Agent resource pages load their primary inventory and direct creation
dependencies independently. `GET /api/admin/template-defaults` returns the
configured Runtime image reference without contacting an owner service; it
does not turn Admin Console into the owner of Runtime or Template state.
Model Profile inventory/detail and the built-in Model Catalog also use separate
browser states. Discovery/catalog failure preserves saved models and their
parameters; builtin and saved candidates remain available where authorization
permits. Refresh never overwrites saved configuration.

The Directory, OIDC/SCIM provisioning, model catalog, and Model
Profile/Template routes are covered by service contracts and browser-route tests.
Console owns release-managed defaults and remote model discovery. Controller owns
current Model Profiles and encrypted connection credentials; Template revisions
reference stable model identities, with optional ordered fallback models.
There is no separate model-history API.

Model reads include a projected Provider endpoint. Model writes accept only
model parameters; they must not copy `base_url` back from that read projection.
Credential rotation uses the Provider connection's credential version. Current
Model edits use `expected_version` and keep the API model name unchanged.
Templates validate image-reference syntax and preserve valid references,
including tags not installed locally; Runtime creation owns image resolution.

Resource responses do not repeat the organization ID that the BFF already
derives from the trusted principal. Read-only Group IDs and OIDC database IDs
are omitted as well. SCIM token ID remains only as the opaque handle for its
revoke command and is not presented as credential identity in the browser.

The single-Agent read includes a detail-only executable configuration lineage
from Agent Controller. Admin Console allowlists the exact Template revision,
frozen model parameters and execution policy, and Runtime input.
It omits Provider credential references, Runtime execution identity, and MCP
routing. Agent lists remain lightweight and do not load lineage.
Template links resolve the exact immutable revision; Model links open current
settings. Later catalog changes do not replace the Agent's frozen build details.

Primary Model, Template, and Agent detail reads preserve terminal error
semantics. `404`/`410` render a missing-resource state, `403` renders a
permission state, and neither offers a futile retry. Other failures remain
retryable. Every terminal state keeps an explicit route back to the owning
inventory.

Primary Model, Template, Agent, and Directory inventory reads use the same
classification. A failed refresh keeps any previously loaded projection, and
the current/deleted Agent inventories remain separate failure domains. Only a
transient owner-service failure exposes a retry action.

Fleet presentation does not promote opaque control-plane identities into
ordinary administrator language. List rows show one lifecycle status and add a
desired target only while the two have not converged. Exact Agent, Runtime, and
Execution revision identifiers and event trace correlation remain available in
default-collapsed technical details on the owning Agent page.

For organization administrators, the BFF always uses the organization from the
trusted principal. A system administrator initially operates in the
organization represented by the login membership. Future organization
selection requires an explicit Identity contract; the browser cannot choose an
arbitrary organization ID merely by changing a request body.

The BFF generates `request_id`, sets `organization_id`, and sets
`actor_principal_id` where required. It never accepts those authority fields
from browser JSON.

## Frontend Workflow

The first usable screen is the application, not a marketing page. An
unauthenticated browser enters its organization and sees local login plus the
enabled OIDC methods returned by Identity. An authenticated administrator can:

1. follow a derived Model → Template → Directory → Agent setup path without
   creating Console-owned wizard state;
2. distinguish an empty resource catalog from an unavailable owner service and
   retry failed reads where they occur;
3. inspect current-organization People and externally synchronized Groups;
4. create local users and edit local Membership profiles, roles, and access;
5. globally activate or deactivate a User when operating as a system administrator;
6. configure and enable or disable OIDC login Providers as a system administrator;
7. issue, inspect, and revoke organization SCIM credentials, with one-time secret display;
8. create and list Model Profiles;
9. create and list Agent Templates;
10. create an Agent for one active directory user;
11. inspect Agent status, exact executable Template/Model lineage, the active
    lifecycle operation, and ordered events;
12. rebuild, disable, enable, and delete the Agent;
13. keep deleted Agents out of the current Fleet while resolving their retained
    projection and lifecycle history through an explicit read-only view;
14. traverse Model Profile, Template, current Agent, and deleted Agent
    inventories incrementally, retaining already loaded records across a
    retryable page failure;
15. see their Identity-owned display name, email, and human-readable
    Organization context in the global shell without exposing internal
    identity IDs, while a failed profile read remains locally retryable and
    does not block the authenticated Console;
16. rotate their own local password only when Identity confirms that a local
    credential exists, without exposing a target-User selector or persisting
    either credential field.

OIDC Provider and SCIM credential inventories are independent failure domains
inside Provisioning. Either section can load and remain usable while the other
fails, and each transient read failure has its own retry. Directory and Provisioning
command errors are rendered beside the active form or confirmation while its
input remains intact. Clipboard failure does not dismiss or persist a newly
issued SCIM credential; the user can retry while the one-time dialog remains
open.

Optional browser resources preserve their structured failure kind. Model
Catalog, Runtime defaults, referenced current Models, account profile,
OIDC/SCIM inventories, and paged dependency selectors expose local retry only
for transient failures. A terminal permission or missing-resource response is
still named in place but does not offer an action that cannot succeed; already
loaded primary records and selector options remain available.

Provisioning shows the public Edge OIDC callback and SCIM base URL in the
matching view and setup dialog. The values come from the browser origin with
fixed protocol paths, not from Identity's private service address or a
user-editable deployment setting. Clipboard failure is visible without hiding
the source value; the SCIM issuance dialog keeps both endpoint and one-time
credential available until explicitly closed.

OIDC login start and callback are no-store flows. Identity returns the
authorization URL to Edge and later returns its one-time Antnest access token
only to Edge; Edge establishes the standard browser cookies and redirects to
the application. Callback failures return a stable login-page error without
echoing Provider details, state, code, or credentials. SCIM requests retain
their protocol Bearer header through Edge, while browser cookies and incoming
trusted-principal headers are stripped.

SCIM Memberships and Groups remain read-only in the Console. Identity rejects
local replacement of externally owned profiles and serializes local
administrator changes so an Organization always retains one effective active
administrator. Organization administrators can change only Membership state;
the system-wide User activation command is available only to a system
administrator.

Lifecycle commands show their accepted operation immediately and converge from
authoritative operation/Agent/event reads. UI state is never the source of
truth.

## Trace Contract

The [cross-service observability contract](observability-contract.md) replaces
ad hoc instrumentation and recursive readiness.
It adds consistent client/server boundaries and bounded request/response/error
diagnostics. Until its per-service rollout is verified, the following sections
describe the existing implementation, not conformance with that target.

Edge Gateway starts or continues one server span for each request and returns
its trace ID in `X-Antnest-Trace-ID`. Every internal HTTP client injects W3C
`traceparent`; every receiving service extracts it.

Agent creation has two distinct observability boundaries. The admission request
trace must contain spans from at least:

```text
edge-gateway
admin-console
agent-controller
identity-service
```

The accepted lifecycle operation then advances through durable worker attempts.
Every attempt starts a new root trace with Span Links to the admission trace and
the previous attempt. The traces correlated by the operation request ID must
collectively contain `agent-controller`, `antnest-runtime-egress`, and
`runtime-controller`. A single terminal-phase trace is not required to contain
dependencies called by earlier phases. Runtime Egress deliberately does not
emit packet-level spans. Lifecycle event records may retain the trace ID of the
phase that emitted them, but Jaeger is the authoritative detailed trace view.

For create, the required phase evidence is explicit:

| Phase | Required services in that phase trace |
| --- | --- |
| `network_ensure` | `agent-controller`, `antnest-runtime-egress` |
| `runtime_initialize` | `agent-controller`, `runtime-controller` |
| `publish` | `agent-controller`, `antnest-runtime-egress` |

Every returned phase trace has exactly one parentless lifecycle root carrying
the operation request ID, lifecycle kind, and phase. All roots after the first
link to the preceding attempt; retries may add roots but cannot remove a
required phase. Required services are derived from spans actually present in
each trace, and all returned lifecycle traces are checked for secret material.

## Deployment Rules

- Edge Gateway is the only application service with a production host port.
- PostgreSQL and Jaeger UI may have loopback-only development ports.
- Admin Console, Identity Service, Agent Controller, Agent ACP Service, Runtime
  Controller, and Runtime Egress use internal Compose networks only.
- Edge Gateway readiness is local and does not probe downstream services.
  Deployment acceptance checks every container and actual business requests.
- Admin Console readiness is local. Services with an owned database may check
  that database, but do not recursively probe another business service. See the
  [service rollout](observability-rollout.md) for implementation and acceptance
  status; deployment ordering does not change this readiness contract.
- No service may read another service's database or bootstrap secret.

## Stage 3A Acceptance

The repository acceptance starts from a disposable Compose project and empty
volumes. It must prove, in order:

1. build all Stage 3A images and start an empty deployment;
2. bootstrap the configured organization and local system administrator;
3. log in through Edge Gateway and load the management projection; interactive
   browser evidence is recorded separately in the C4 reports;
4. view the organization directory and bootstrap administrator;
5. rotate the bootstrap administrator's local password, prove the replacement
   credential can log in, and restore the disposable fixture credential;
6. issue, list, and revoke one SCIM credential while proving that ordinary
   reads never redisclose it;
7. create one Provider connection with a disposable credential and a selected Model Profile;
8. create one Template referencing the stable Model Profile identity;
9. create one ordinary organization member and one Agent owned by that member;
10. wait for the lifecycle operation and Agent to become ready and inspect its
   ordered events;
11. disable, enable, and rebuild the Agent, waiting for each operation to reach
    its terminal state;
12. query Jaeger for the lifecycle command and Temporal workflow/activity chain
    correlated with its operation; prove actual ancestry, required boundaries
    and secret exclusions, keeping strict warning results explicit;
13. prove that only Edge Gateway has an externally reachable application port;
14. log in as the ordinary member, obtain a browser-safe Agent projection and
    Workspace HTML, and execute/replay real Tool effects on ACP v1 WebSocket,
    v2 WebSocket and v1 HTTP; verify workspace/history retention after Rebuild
    and authoritative logout revocation on both WebSocket versions;
15. delete the Agent, prove its Runtime container and workspace volume are
    reclaimed, prove the default list hides it, and prove the explicit deleted
    query retains its audit projection;
16. tear down all containers, networks, and disposable volumes on success or
    failure.

Unit and contract tests cover authentication, privilege checks, header
spoofing, organization scoping, request shaping, secret redaction, trace
propagation, static fallback, and lifecycle forwarding. The Compose acceptance
is the cross-service proof, not a replacement for those tests.

Run `make e2e-stage3` to build images first, or `make e2e-stage3-local` to use
existing local images. The [current base fixture](../scripts/stage3-base/README.md)
uses an isolated Compose project with empty volumes, all five lifecycle command
traces and independent ACP message traces. It verifies current configuration
publication/settlement, real Runtime operations and host-port isolation, then
tears down owned resources on success or failure. Clock warnings still produce
a nonzero result.

Managed MCP now has an independent disposable [current fixture](../scripts/managed-mcp/README.md)
for both SDK versions and active-Run Rebuild.
The [current RPC fault fixture](../scripts/rpc-response-loss/README.md) covers
both-version publication/settlement acknowledgement loss. Its business checks
pass; the subsequent Controller candidate closes background publication SQL
tracing. Strict warnings and Docker probe errors remain failed. The separate
[ACP persistence fixture](../scripts/acp-persistence/README.md) now has six
committed-response-loss cases and 32 scoped Trace checks; strict faults remain
failed. [Process interruption](../scripts/acp-restart/README.md) now has eight
business cases, 18 replays and two physical Rebuilds. Its 44 complete Trace checks
passed in the original run. The [Trace follow-up](trace-acceptance-followup.md)
separates intentional SIGKILL diagnostics from normal-request completeness and
validates expected Docker absence in the independent candidate; strict timing
warnings remain outside this scope.
See the [separate P1/P2 record](acp-persistence-revalidation.md).

The historical retained-stack, OIDC and fault branches remain for
their separate migration batches; they are not included in the current default
base acceptance. In particular, `ANTNEST_E2E_KEEP_STACK=true` still selects the
historical driver and is not a validated current seeding entry. Track pending
consumers in the [asset inventory](acceptance-asset-migration.md).
