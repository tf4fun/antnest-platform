# Identity and access E2E

These disposable Stage 3 profiles exercise the real Edge Gateway, Admin Console
BFF and Identity Service against disposable PostgreSQL databases. They cover
local login, SCIM, OIDC, HTTP access isolation and expiry, Agent organization
access and owner offboarding, and the effect of identity changes on ACP
connections. The [contract](migration-contract.md) lists what each profile must
prove.

The default HTTP and SCIM client has no database or Docker access and uses only
synthetic credentials. Business mutations go through the Gateway. The ACP
profiles additionally use a read-only connection to ACP-owned tables to verify
that rejected requests and history replay have no durable side effects. Strict
Trace warnings and expected rejection errors are reported as failures.

## Running

| Command                         | Profile                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `make e2e-identity-core`        | Local login, SCIM and OIDC                                                      |
| `make e2e-organization-display` | Real local/OIDC browser sessions, Organization projection and display freshness |
| `make e2e-identity-access`      | HTTP access isolation, Identity outage and token expiry                         |
| `make e2e-agent-access`         | Agent organization access and owner offboarding                                 |
| `make e2e-acp-session`          | Browser logout and Identity faults on existing ACP connections                  |

All targets require Docker and the local Stage 3 images
(`make docker-build-stage3`). Each profile is independent and must not be
combined with another fault profile or `ANTNEST_E2E_KEEP_STACK=true`. The fixture
helpers run without Docker as part of `make test`:

```sh
node --test --test-concurrency=1 tests/e2e/identity-closeout/*.test.mjs
```

Helper tests do not replace the real integration run.

### Private initialize result contract

`openBrowserPrivateACP` and `openPrivateCommandConnection` expose
`initializationResult` after their single successful initialize and existing
cancellation checks. This is the actual SDK return value; v2 applies its own
schema parsing before returning it. The helpers do not synthesize capabilities,
normalize v1 booleans into v2 objects, or send another initialize. Explicit
false/null values and omitted capabilities remain unchanged. Session requests
and joined connection cleanup do not replace this result.

Owning consumers must inspect the appropriate protocol's negotiated capabilities
from this value. The shared contract tests cover real v1/v2 WebSocket and v1 HTTP
connections; multimodal behavior and production-stack admission remain a separate
consumer batch.

### Private v1 HTTP lifecycle contract

The shared `createPrivateACPHTTP(endpoint, options)` transport precedes its
pending slash-command consumer. It wraps the locked SDK's real HTTP stream;
the owning client connects `stream`, calls `bindConnection(connection)`, awaits
its actual initialize result and then calls `completeInitialization()`.
`closeAndWait()` returns one stable promise and owns the original stream readers,
writers, pending requests and response bodies. `connection.closed` alone is not
proof of cleanup. The initialization-only `signal` and deadline are detached
after successful initialization; later lifetime shutdown uses `closeAndWait()`.

`headersFor({ method, signal })` supplies the current issued
`Antnest-Caller-Context` and `Antnest-Service-Authorization` on every actual
request. It may reuse a still-valid context or refresh it from the same original
browser session. It must settle after cancellation. It cannot override SDK
connection/session headers or inject Cookie or trace headers. The endpoint is
an exact plain HTTP(S) `/v1/acp`; redirects and cookies are disabled, and business
POSTs are never replayed automatically. Each actual GET, POST and DELETE injects
its own exported CLIENT context from `createPrivateACPTelemetry.startHTTP`.

Initialize uses 200 JSON; later 202 responses acknowledge POSTs while their RPC
results arrive over connection or Session SSE. Results do not require SSE EOF.
The safe `snapshot()` retains per-request method, RPC identity, transport IDs,
status, CLIENT IDs, byte count and original body outcome, without credentials or
business contents. Normal cancellation is preserved without marking ERROR;
failed status and independent request/body/cleanup errors remain failures.
An unread ACK is cancelled and joined, never relabelled as EOF.
The final CLIENT outcome and `antnest.http.body.outcome` are recorded separately:
an incomplete DELETE remains an ERROR while preserving its actual cancelled body
and HTTP status. Synchronous connection-close failures use safe diagnostics and
cannot skip the remaining stream, request or response-body joins.
CLIENT `end` failures also fail cleanup with safe request diagnostics; they
cannot create a completed `ended` receipt. A partly completed `end` is not
retried, and cleanup still joins the remaining responses and DELETE.

DELETE has its own cleanup signal and must finish with exactly 202 and a fully
drained body of at most 64 KiB. Late initialization and the SDK's automatic
DELETE are joined too, with exactly one DELETE for an observed target. A cleanup
deadline aborts the actual I/O and still joins it before failing. This shared
SDK/TCP/OTLP contract does not complete slash-command, candidate image migration,
Identity authorization, or Docker integration; those are separate owning batches.

The shared private ACP helpers support an explicit `boundary: "private-acp"`
on `connectACP`. Each owning consumer must obtain `workspaceContext` from the
existing browser access token and use the `agent-ui-acp` workload authorization
from `serviceClient`. Pass the issued context, authorization, exact private
`/v1/acp` or `/v2/acp` endpoint and a `createPrivateACPTelemetry` provider; the
Cookie argument must be `undefined`. Header overrides and disabling the actual
CLIENT trace context are rejected. The default remains the Gateway boundary
until each consumer is migrated and admitted separately.

The telemetry provider exports real root CLIENT spans under
`antnest-private-acp-client`. It records successful 101 only after the official
SDK transport reaches `open`; rejected or invalid handshakes remain failures.
The private response's `X-Antnest-Trace-ID` is never used as proof. A client's
`connectionTraceID` and `clientSpanID` identify its exported CLIENT context;
the actual ACP SERVER span must still be discovered from raw evidence.

Each exported CLIENT resource includes the actual host name, numeric PID,
Node runtime and SDK metadata. Its service instance uses the same host/PID
convention as ACP, so providers in one process share an identity and separate
processes remain distinguishable. This does not establish a globally unique
process generation across restarts or defer cross-process timing warnings.

The private telemetry exporter admits at most 256 unfinished exports, including
at most eight in-flight OTLP requests. It passes each admitted original SDK span
to the SDK exporter once; overflow fails explicitly with the rejected Trace/Span
identity. The first export failure and its cause remain failures of every later
`flush` and `shutdown`, including after successful exports. Both operations join
the queued exports and the underlying exporter before reporting failure, and
shutdown still closes that exporter. A provider flush deadline also waits for
delivery to finish before returning its original error. End every CLIENT span before
shutdown: unfinished spans fail shutdown, and a late `end` is rejected instead
of silently disappearing. Export completion alone does not prove collector
acceptance or Jaeger indexing; the complete raw parent chain remains required.

`collectPrivateACPTrace` requires a nonempty durable evidence directory, a
provider `flush` callback and the owning request inspector. Supply the actual
method, request ID, Agent, protocol version and applicable Session, plus the
CLIENT IDs; do not supply `connectionSpanID` or `connectionTrace`. Collection
discovers the unique workspace upgrade and verifies its exported CLIENT parent,
then binds the request's exact Link and original ACP process resource identity
(`host.name`, positive numeric `process.pid`, and `service.instance.id`). Each
identity attribute must occur exactly once in both raw resources. Trace-local
process IDs may differ; the resource tuple must match. This binding does not
claim a globally unique process generation across restarts. Private request
reports do not claim Gateway ancestry. Three consecutive complete raw snapshots
and candidate inventories must agree. Every received query body is saved before
parsing or validation, with its SHA-256 receipt, including unsuccessful attempts.
The caller must include its CCT, workload credential and other canaries in
`secrets`; warnings and errors from both sources remain visible even when an
older owning inspector does not recognize a diagnostic. A collected record
with `strict_trace: "failed"` still requires owning review. Close each client
and shut down its telemetry provider in `finally`.
Raw error counts use the shared diagnostic predicate: cancellation alone is not
an error. A request's verified read-close cancellation remains in its original
spans and owning proof; real error fields and warnings still fail strict checks.
The successful private upgrade independently rejects any canceled exchange.
Session success checks also reject failed or conflicting HTTP status fields
in tags and events, and unowned warning/error log levels. A dedicated owning
proof is still required for expected diagnostics; generic success cannot
silence them or rewrite the original records.

The loopback SDK/OTLP and raw-collector tests cover these shared tools only.
ACP Session faults, Agent access and ACP Closeout still require separate
consumer migration and real Docker authentication, business and Trace evidence.

The Session fault migration uses the private SDK for protocol and execution,
and a separate same-Session Bridge SSE for browser authorization. A private ACP
connection does not prove silent browser logout, outage or expiry enforcement.
`observeBrowserSession` retains the original Cookie independently of the browser
that logs out. Checkpoint before the fault, observe a remote close within the
fixed 30-second bound without SDK or browser probes, then send an actual prompt
denial using the original Cookie. The denial must preserve the expected status
and code, no-store policy and absence of Cookie writes. Cancellation waits for
that bounded HTTP request to finish and cannot turn into a passed check.
The close receipt deliberately leaves `authorizationCauseVerified` false:
independent Identity state, CCT/session deadlines and the raw Bridge/Resolve
Trace closure must still prove the cause in the owning Docker scenario.

Cross-service membership, SCIM and administrator revocations observe an already
warm Principal until the actual deployed Gateway snapshot TTL. Every response
retains its unique Trace ID, monotonic send/completion times and original
Principal; successful reads must keep the original Cookie, DTO and no-store
policy, and the final response must be `401 unauthenticated`. The deadline is
fixed at the mutation response and is never extended by a successful read.
Cold scopes and local Gateway logout, password changes and self-revocation keep
immediate denial checks, as does replay of an old Cookie after restoration.
Partial observations are saved before validation. The Identity deployment
inspector supplies `ANTNEST_E2E_RESOLVE_TTL_MS` from the actual container setting.
Transport and JSON decoding failures stop immediately; they cannot supply a
decoded observation. Content-validation errors use fixed messages, while the
actual response values remain in private evidence.
Identity HTTP access and expiry use the active Agent UI Bridge bootstrap at
`/api/app/workspace/v1/bootstrap`. Its shared schema and production decoder are
checked against the full login Principal and an explicit initial Agent inventory;
Organization labels and administrator scope must match. During revocation the
directory may shrink, but a removed Agent cannot reappear. Session responses
retain the complete original Principal comparison. Every observation is saved
before validation, with the original Cookie and mutation deadline unchanged.
Cold outage preparation still performs only login; all three protected scopes
must return the actual Identity-unavailable 503 without Cookie writes.

The owning runner independently resolves its selected Identity image before
inspecting the initial container, then requires the same image after the expiry
recreation. Both observations bind the project, service, full container/image
IDs, healthy state and read-only TLS trust. The initial token TTL is exactly
12 hours; the recreated expiry container must use exactly 5 seconds, without a
build or pull. Safe lifecycle receipts are retained beside the deployment proof.

Organization feed searches select the unique Identity SERVER by service,
route, method and RPC, then require its direct Gateway CLIENT parent. CLIENT
and SERVER ordering in Jaeger search results does not affect the original
observation window or the subsequent empty-page SQL checks.
The feed query's end and lookback are fixed to the observed display/proof window,
rounded outward from microseconds to Jaeger's millisecond boundaries. Collection
delay cannot extend that window into a later feed whose export is incomplete.
Exact CLIENT-time selection, complete parent chains, zero-row SELECTs and
unread-page rejection remain required inside the window. Refresh queries retain
their separate trigger-based selection.

The legacy core, Organization display and offboarding OIDC scenarios explicitly
select `verified_email`, with no domain restriction and no administrator trust.
They preserve their existing member-convergence scenarios; SCIM tokens in those
profiles remain directory-only. New registrations default to `none`.
`make e2e-browser-sessions-https` exercises that safe default against an asserted
organization-administrator email, then uses real Console pre-binding and paired
SCIM controls to admit browser logins. It also verifies notices, explicit
restoration, last-method confirmation and session retirement without offboarding.
The HTTPS IdP uses a disposable CA and one hostname shared by Identity and
Chromium; the browser context sends the two fixture hosts directly, without
changing machine proxy settings or intercepting product APIs. Raw and partial
TLS connections, browser contexts, candidate images and stack resources are
closed on success, failure or interruption.
For organization-admin revocation, the HTTPS fixture observes both original
browser sessions against one mutation timestamp and the inspected Gateway TTL,
saves each response before validation, and joins both observations before
checking stream and private-UI retirement. Its password and self-revocation
checks still require immediate rejection.

The same HTTPS suite runs password admission against two real Identity containers
sharing PostgreSQL and the same immutable candidate image. An external database
transaction controls fifth/sixth attempts and legacy-login/password-rotation
ordering; admission requires the actual PostgreSQL blocking graph. Browser
requests check canonical 429/503 responses, retry hints, unchanged Cookies and
durable state, followed by explicit recovery. An isolated account's valid
128 MiB, 10-pass historical PHC occupies the entire unchanged KDF memory budget
under a temporary 0.1 CPU quota. A single invalid-namespace dummy probe must
return typed KDF `wait_expired`; each public login, password change and Console
user creation is then sent once and must receive the same KDF refusal. PostgreSQL
and same-instance raw Trace evidence must place every target response between
the holder's credential read and its first post-verification SQL. A past queue-full
observation is insufficient. Only the holder's two counters may record its one
deliberate wrong password, with their shared first-failure window bounded by
actual PostgreSQL timestamps; target counters, credentials, sessions and Cookies
remain unchanged. This 12-second fault phase is separate from normal-CPU
200-request/RSS admission. The fixture restores CPU before joining HTTP requests
and the actual server transaction, including on timeout or cancellation. Closed
response diagnostics are recorded before assertions without copying credentials,
Cookie values or arbitrary response text. The peer and database connections close
before the existing session flows.

The core client is invoked by the parent as:

```sh
node tests/e2e/identity-closeout/client.mjs "$gateway_url" "$jaeger_url"
```

It requires a Stage 3 synthetic administrator and creates uniquely named test
users, groups and tokens. Never point it at production. All HTTP requests are
bounded; there are no background workers or external Providers. Output is
compact final counts and Trace summaries, never credentials or payloads.

## Local login and SCIM

Before the Gateway suite, `principal-client.mjs` calls the real Identity
local-login and resolve-access-token RPCs from a disposable container in the
internal Docker network. Both principals must contain the bootstrap
Organization's slug and name. The result contains check names only, without
access credentials. This producer probe is independent of Gateway's response
projection. Set the test-only `ANTNEST_E2E_IDENTITY_IMAGE` override to validate
an isolated candidate image without replacing the local development tag.

The real Gateway login and session outputs are separately checked against
[`session-response.schema.json`](../../../contracts/edge-gateway/session-response.schema.json)
by `organization-session.mjs`, including ordinary/admin local sessions and OIDC
sessions. Missing or mismatched Organization labels and credential fields fail
admission. `ANTNEST_E2E_GATEWAY_IMAGE` selects an isolated Gateway candidate;
this producer regression alone does not prove the Node/SSR/browser consumer #93.
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` similarly selects a current RC dependency
image (including its Skill preparer) when the local tag has fallen behind
deployment changes. Both overrides apply only to this disposable profile.

## Organization display integration

`make e2e-organization-display` uses an independent core-composition profile after Gateway #92
and Agent UI #93 have each passed their service admission. It runs the real
Identity → Gateway → Node bootstrap → browser workflow, including local login
and an OIDC login initiated in the product UI. The browser-facing IdP authorize
hop maps the fixture's internal DNS name to its published TLS port; it forwards
the real verified HTTPS redirect without mocking Identity, Gateway or Node.
Identity still performs real discovery, token exchange and JWKS verification.
It provisions its own synthetic users and OIDC Provider; it does not reuse the
login-attempt budget consumed by the core suite's rejection/rotation scenarios.
Gateway's normal login limits remain enabled.

The same User is a member of one Organization and an administrator of another.
Each has a real Controller-created Agent, synthetic model configuration and a
Runtime; no model prompt is submitted. The actual Node response is validated
against the central schema and passed unchanged into the production frontend
decoder. JavaScript-disabled SSR and hydrated chooser/account labels must agree
with the Identity Organization row, including Unicode and escaped HTML text.
Forged headers, foreign Agent requests, logout/cookie replay and inactive local
and OIDC memberships must retain ID-based authorization boundaries.

After membership deactivation, Controller's live directory can empty before
Gateway evicts its still-valid Principal snapshot. During this bounded rejection
window, each 200 must retain the exact verified Principal and complete valid
metadata, while its Agent IDs may only be a subset of the preceding read. This
serial fixture performs no restoration inside the window, so a removed Agent
must not reappear. Healthy rename/bootstrap/SSR reads still require the exact
fixture directory. Cold workspace scopes reject immediately, and warm reads
must converge to 401 within the existing TTL admission bound. Every transitional
response is retained privately; successful 200 request/source Trace closures
are validated and included in the final strict result.

Gateway's Go real-output schema tests use `santhosh-tekuri/jsonschema` with the
default Go regexp engine, whose `\s` whitespace class is ASCII-only (`\S` is
its complement). Those
schema checks alone do not establish rejection of Unicode-only whitespace such
as NBSP. Gateway's Identity-client `verified()` validation rejects blank labels
before projection, with a separate Unicode-whitespace regression. Node also
requires non-whitespace decoded labels, and the central-schema checks here use
Ajv's JavaScript regexp semantics. Admission combines the Go schema gate with
these boundary and cross-service checks.

Because Identity has no public Organization rename command, a coordinator-only
fixture checks disposable project/run ownership before reading and temporarily
changing only `organizations.slug/name` in the Identity test database. It
restores those columns on exit. Reload and re-bootstrap must observe the change
without altering principal IDs/roles, Agent selection or an unsaved draft. The
other Organization remains unaffected. This fixture is not a product rename API.

The cache admission reads the actual Gateway container settings and requires
the default 10-second Resolve TTL with RPC content capture disabled. Six fresh
login tokens independently warm session, bootstrap and SSR, each in continuous
and quiet-expiry modes. Bootstrap and SSR otherwise share the same workspace
profile with no Agent selection. Two early cache hits precede the rename;
continuous passive GETs span the TTL, while the quiet scopes are next read only
after the observed commit plus TTL. Half-TTL refresh may expose the new labels
earlier. The report separates read scheduling delay from response latency and
does not reject a request admitted before expiry solely for completing later.

This passive interval precedes browser draft input and Refresh clicks, whose
activity requests can evict a session cache. Actual Gateway/Node admission,
Resolve CLIENT/SERVER/SQL and separately searched refresh/trigger traces are
archived with complete source closures. Healthy empty feed pages require the
real `session_revocations` SELECT with `pgx.rows_affected=0`; observed poll gaps
must stay within 2.5 seconds, cover the interval and accompany advancing cache
proof observations. Hits cannot reset the original snapshot age. These checks
retain strict Trace warnings and missing-parent failures. This HTTP composition
does not substitute for #59's separate HTTPS outage and load admission.

`ANTNEST_E2E_AGENT_UI_IMAGE` selects an isolated UI candidate alongside the
Identity, Gateway and RC overrides above. Playwright comes from the locked Agent
UI dependencies and requires its Chromium installation. All contexts and child
processes are closed before the parent removes its Docker resources. Browser
JSON/HTML and service logs are scanned for synthetic access credentials. Private
evidence retains timing, synthetic display values and raw Trace closures, with
no session cookies or RPC content. Session cookies and IdP canaries
remain in memory or the parent's private temporary directory and are removed on
teardown.

Unexpected browser 5xx responses retain their actual response Trace IDs. Before
teardown, the runner attempts to archive the last four failed request closures
as diagnostics while retaining the original business failure. A failed Refresh
response body is scanned for fixture secrets before private retention. The
membership rejection loop also saves each completed read's timing/status/Trace
and the last secret-checked JSON response before validating its content. A
failed content assertion therefore retains its actual 200 response and Trace
closure without retrying the request or changing the admission verdict. JSON
decoding or credential-scan failures still reject before body retention.
The optional private diagnostic log also includes Agent UI, Controller and ACP;
these diagnostic records never establish admission or replace a passing run.

The shared Stage 3a overlay also accepts `ANTNEST_E2E_CONSOLE_IMAGE`,
`ANTNEST_E2E_CONTROLLER_IMAGE`, `ANTNEST_E2E_ACP_IMAGE` and
`ANTNEST_E2E_EGRESS_IMAGE`. Local admission must verify build inputs or build
current candidates for every changed image; an old `:local` tag is not evidence
for the current checkout. Candidate overrides leave baseline tags intact.

For an independent revocation-consumer diagnostic,
`ANTNEST_E2E_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL=100ms` selects
Controller's existing poll interval in the disposable Identity overlay. The
default remains 2s, and retained deployment Compose does not use this override.
The deployment report verifies and records the actual container setting. A
shorter interval increases the opportunity to observe Controller directory
revocation before Gateway cache eviction; it does not guarantee their order or
establish the cause of a historical failure. Membership scope, bounded rejection
and strict Trace gates still apply during this diagnostic.

1. Local login establishes HttpOnly session cookies without returning the token
   in JSON. Member access, rejected CSRF logout, successful logout and replay of
   the revoked cookie are tested separately.
2. Membership deactivation denies an existing HTTP session and a new login.
   Global User deactivation also revokes issued tokens; reactivation requires a
   new login. This does not cancel an already-admitted ACP Run.
3. SCIM discovery, read and write scope enforcement, Users and Groups CRUD,
   filtered listing, group membership PATCH, deactivation and reactivation,
   deletion and reprovisioning are exercised through `/scim/v2`. Public
   Location URLs and Console directory projections must agree with those
   mutations.
4. SCIM rotation issues a replacement and revokes the old credential. Lists
   never redisclose secrets, and browser cookies do not authorize SCIM.
5. Jaeger assertions require actual parent chains from the Gateway through
   Identity to its owning PostgreSQL spans, including the Console for
   administrator mutations. Console expectations select the `console` Resolve
   profile; password-change expectations explicitly select `session`. An
   admitted Resolve decision must finish before the real Gateway forwarding
   CLIENT. Its `rpc`, `cache`, or `shared` evidence never replaces the business
   operation's own SQL or the actual IdP request checks. Login, OIDC and SCIM
   operations do not acquire an invented Resolve requirement. Passwords,
   session cookies and SCIM credentials must not appear in any collected Trace.

## OIDC

The core profile starts a disposable HTTPS IdP fixture. It implements discovery,
authorization-code redirects, one-use code redemption with exact client and
redirect binding, PKCE S256, and RSA-signed ID tokens that the real Identity
service verifies through JWKS. The fixture auto-authenticates selected synthetic
accounts; it does not test any vendor's IdP login UI.

The test-only Compose override trusts a fresh one-day certificate through
`SSL_CERT_FILE`; TLS verification is never disabled. The host client maps the
fixture DNS name to its loopback-published port while keeping hostname
verification. Neither the CA nor the fixture is enabled in deployment Compose. A
named test certificate volume allows keep-stack restarts and is removed with the
fixture on normal teardown.

The suite covers SCIM and local account convergence, stable subject binding,
inactive and unknown account rejection, refusal to federate system
administrators, wrong nonce rejection, browser-transaction transfer denial
before token exchange, callback replay and concurrent-start replacement.
Provider disable and secret rotation are verified against real discovery and
exchange. All provisioning and login requests enter through the Gateway, with no
direct SQL writes. The fixture's counters serve only as a protocol-execution
oracle.

The denial cases use a second issuer path, respecting Identity's
one-issuer-per-organization rule. Re-login with the same subject but a changed
email must keep the original User and Membership instead of re-linking by email.
A separate `/profile` issuer returns an ID token without email and exposes
authenticated UserInfo, proving the fallback path; the fallback must converge to
the same provisioned User and Membership.

Trace checks require exactly one finished, successful IdP HTTP client span per
expected method and endpoint, under the same Identity server span that owns the
persistence. Provider registration covers Discovery; the login callback covers
Token and JWKS. The fixture records received method, path and `traceparent`
(never queries, credentials or bodies), and their span IDs bind each endpoint to
the exported host, scheme and port attributes. Missing, detached,
foreign-request, duplicate or failed spans fail the verifier.

Test-only evidence endpoints expose synthetic PKCE verifiers, signed ID tokens
and Basic credentials to the coordinator's scanner, never to product clients.
Trace and log scans include these canaries and their URL-encoded forms. Logs
must contain correlated request records from the Gateway, Console and Identity;
empty or startup-only output cannot pass. Transport errors (including nested
causes) and JSON parser errors cannot redisclose raw Gateway, Jaeger or IdP
responses. Failure diagnostics print only bounded service and level counts.

## HTTP access isolation

`make e2e-identity-access` does not share login attempts with the other
profiles and does not change login limits. Identity's private RPC prepares two
organizations and ordinary organization administrators (not system
administrators). All access assertions go through the Gateway; no database rows
or clocks are modified.

Unexpected access HTTP statuses retain a private receipt containing the status,
expected status, actual response Trace ID and an allowlisted error code before
the original assertion fails. A bounded 20-second collector archives the actual
Resolve closure under `traces/request-failure-traces/`; its reports are failure
diagnostics, never admission. Missing Trace IDs and collection failures remain
explicit. Requests are not retried and failed responses do not update the Cookie
jar. The disposable parent keeps Gateway, Console and Identity service logs in
`services.private.log` before teardown. Raw response bodies, headers and arbitrary
error messages are excluded from the receipt.

The same email is provisioned with separate identities and passwords in each
organization. Tests compare directory and SCIM projections, reject foreign
resource mutation and forged scope headers or body fields, and exercise password
rotation and logout independently. A password change at `/api/session/password`
replaces the current session without extending its absolute deadline and revokes
all previous sessions of that User, including sessions in other organizations.
Logout revokes only the presented session. Membership deactivation revokes that
membership's sessions; restoring the membership does not revive old cookies.
The User-deactivation check starts with newly authenticated sessions so an
earlier revocation cannot produce a false pass.

The password command assertions distinguish `400 invalid_current_password`
(no cookie change, later access succeeds) from `401 unauthenticated` after real
token expiry (no cookie change, password unchanged). Ordinary requests never
clear cookies on 401; explicit logout clears both session cookies even when the
session has expired. Console and Agent UI tests verify password-dialog retention
versus returning to login, including late responses from an older in-page
session.

Finally the coordinator issues a new session without reading a protected route,
then stops only Identity. The first session, console and workspace reads must
all fail at Gateway with `503 identity_unavailable`, no-store and no Cookie
change. Login does not populate the Resolve cache. This cold-scope check does
not classify a warm Console account request whose downstream Identity call
fails; cached authority and ongoing ACP work during an outage have their own
Resolve-cache E2E coverage. The stopped Identity keeps its pinned
Compose address and drops connects. Gateway's 5-second dependency connect bound
must report the outage within the default 15-second request wait. It restarts Identity with the token TTL set
to five seconds for new tokens: the earlier long-lived cookie must recover, and a
new short-lived cookie must work before its deadline and fail after it, even when
replayed manually. Explicit logout must clear the expired cookies, and a fresh
login must then work. The short absolute TTL override exists only in the fixture
Compose. HTTP logout and expiry results are not WebSocket token revocation
results.

## Agent organization access and offboarding

`make e2e-agent-access` uses Identity's RPC to prepare two organizations,
separate organization administrators and one User who is an administrator in A
and a member in B. Agent, catalog and Membership administration use the Gateway;
official SDK requests use the private ACP boundary delegated from each original
browser session. Each organization has its own model configuration,
Template and Agent, and both Agents have the same User owner, so user-only
filtering cannot pass by accident.

The access matrix covers scoped administrator lists, details, operations and
events (including watch rejection), rejected foreign lifecycle commands, forged
organization and role headers and body or query scope, member versus
administrator surfaces, owner-only workspace lists and v1 and v2 ACP
authorization. Identity delegates the original browser Principal; ACP rejects
unauthorized Agent requests with `access_denied`. Within an authorized
connection to a local Agent, foreign Session load, resume, fork, close, delete
and prompt must fail without history or persisted effects. Deactivating only
B's Membership must retire B's original Cookie Bridge SSE and reject a real HTTP
prompt using that same Cookie, without invalidating the
same User in A. The Controller must finish automatic Disable before restoration
is tested. Restoring B keeps the Agent disabled; only an explicit Enable allows
reconnecting with a fresh login and replaying history. Restoring Membership does
not revive the old Cookie. The private SDK connection is separately joined;
local SDK cleanup does not establish browser revocation.

Membership offboarding is checked for both protocol versions. Global User
deactivation across A and B, an unaffected second owner, and SCIM Membership
deletion retain their existing v2 Run/replay coverage. The Runtime's own
inspection API confirms `disabled/absent`, and a
sentinel seeded and read through the official MCP client proves workspace
retention after Enable. The test client joins the Runtime management network
only for this oracle. It reads Runtime state and the per-instance MCP credential
with the disposable `controller-runtime` grant, and reads raw Controller events
with the `console-controller` grant and a caller context resolved from the
admin's existing Gateway session. ACP-owned read-only snapshots prove that
Disable does not delete history or Runs. After explicit Enable, private ACP
Runs under fresh browser authority prove that admission and the shared model
credential still work.

The complete original SDK inventory is twenty initializations and sixty-four
business requests, including nine successful Session creations and six lists.
Original raw replies, SDK results/errors and scoped pre-list database snapshots
are kept privately. Nine no-tool Runs and twelve successful history replays
remain required. The two HTTP denial probes are separate browser evidence.
Browser closure requires an actual UI access-denied witness, terminal Gateway
Resolve rejection or winning Gateway session-feed event bound to the original
Identity mutation and Membership scope, plus its matching automatic
Disable. This gate does not claim final closure of Bridge's shared private
owners; that belongs to the Session lifecycle profile.

Gateway feed termination is a shared diagnostic contract for browser consumers.
Each consumer must first prove its own actual Identity mutation and original
browser scope, then bind the event's source span, reason and positive sequence.
Logout uses `session_revoked`; password rotation, role changes and Membership
deactivation retain their distinct feed reasons. The event must follow the same
Gateway process's mutation request and precede its original read failure.
Derive Gateway time bounds from its own root and the client's send/header
interval, not the proxied upstream HTTP Date. Preserve all raw errors and
strict findings; no feed event can excuse the truly stopped Identity interval
or a natural expiry. Typed feed causes require this complete witness.

Outage recovery also binds completed Runtime metadata to the original UI owner:
`session/load` requires its successful view, while `session/new` requires the
original POST 201 creation receipt. Both retain the original login scope,
Agent, Session, request ID and direct UI/ACP parent chain, including asynchronous
POST 202 dispatch. The archive rechecks these owning receipts without changing
the initialize contract. Held-tool cancellation separately proves its original
caller abort, unreceived result and joined connection close; successful metadata
reads and tool catalogs reuse their complete parsed-result/close inspectors.
These receipts preserve raw errors, diagnostics and clock observations.
Final summaries retain these owned metadata close receipts and forbid their owner
from aliasing a held-tool span or any metadata exchange. Raw error counts exclude
only the explicit success sentinels `error.type=""`, `antnest.error.code=""` and
`antnest.error.class="none"`; any other error field on the same span still counts.
Historical failed reports and raw Trace data remain unchanged.

The SCIM owner logs in through the same OIDC fixture, has a peer Membership and
Agent in A, and owns nonempty chat history in B before deletion. A stays usable
while B is disabled. Reprovisioning keeps the User, creates a new Membership and
permits old Session replay and a new Run only after explicit Enable. The
coordinating shell stops the Controller before global revocation and restarts it
afterwards; the committed event must be consumed after restart without
duplicating earlier offboarding. The client only requests named checkpoints and
has no Docker socket.

Jaeger evidence must connect each source Gateway request to Identity receipt,
Controller scheduling and the matching Temporal Disable workflow by exact parent
IDs. Each activity must commit its own driver write. Drain must acknowledge the
current ACP publication and settlement. Runtime Controller and Egress control
RPCs must descend from their activity, including the mutating method and route
(Inspect alone is not enough).

Official SDKs drive both protocol versions. A local model fixture verifies the
organization-specific credential and context before answering; positive Runs
must persist and replay their private history. Denials must leave owner-side
Agent, catalog and event projections and ACP tables unchanged, with no model
calls. Authorized load and resume with identical empty client MCP sources are
idempotent: every Session row, revision, pointer, timestamp, Run, message and
context checkpoint is preserved. Fresh connections receive matching persisted
Session metadata. Model input and replay reject foreign history, and the replay
oracle compares ordered message IDs and content with persisted history. Error
replies and revocation notifications must not disclose history.

Not covered: packet tracing, crash recovery during Disable, emergency
cancellation and convergence of arbitrary unavailable Runtimes.

## ACP connections and browser sessions

`make e2e-acp-session` uses official SDK clients against the real Gateway,
Identity and ACP services, with synthetic credentials and a local model fixture.
Protocol work uses the private ACP v1/v2 connection with its real Identity
Resolve and signed caller context. Browser authorization is observed on the
original Cookie's Bridge SSE request for that Agent and Session. Its Trace ID
comes from the actual HTTP response. The SDK connection is closed locally only
after the browser's remote close and independent HTTP denial have been observed.

The client mounts the real Agent UI stream parser and protocol source directories
read-only. Its import test reconstructs those mounts with the ACP image's locked
dependencies and verifies that both services use the same Zod version and integrity.

**Logout.** Each version creates a Session and records the original stream
before logout through the Gateway. The stream must close silently within the
30-second authority bound. The logout Trace must prove committed revocation;
an independent POST to the same Session's prompts route, using the retained
original Cookie, must return 401 without a Cookie write or durable effect.
The revocation feed may close the stream before another Resolve failure. A new
login must load or resume the same Session with no rejected prompt or Run events.

**Identity outage.** Both original SSE streams open before the coordinator stops
Identity. Their close observations run together without another SDK request.
The actual failed Resolve and the later original-Cookie POST 503 must both lie
within the independently acknowledged stopped interval. Failure evidence uses
the shared Resolve's actual five-second maximum, preserves the Cookie, and
requires no Run, message or Tool change. The same long-lived Cookie reconnects
after recovery. An empty recovered Session contains its current command catalog,
one untitled Session info update with a valid timestamp and, for v2 replay only,
exactly one idle control update (`assertEmptySession`).

**Expiry.** Identity is rebuilt with a five-second token TTL. The original login
must follow that deployment's acknowledgement and finish before SSE dispatch.
Its separately archived Trace proves Gateway login, successful Identity
`local_login`, the actual token INSERT and committed transaction. The original
CCT ends at the issued absolute deadline rounded down to a whole second; the
stream must close within that preceding one-second grace, without further
browser or SDK traffic. Gateway's actual deployment must retain the ten-second
Resolve cache budget. The later independent POST waits until more than 17 seconds
after the original SSE headers on the client monotonic clock, then must return 401. This is a conservative bound on the five-second token and ten-second cache;
RPC completion and cache hits cannot renew the original source-start budget.
Raw service clocks, database rows and original deadlines remain unchanged.
Earlier long-lived credentials keep working, and the normal TTL is restored.

**Admitted work.** A local model fixture holds a real request. Once its Run is
running, the client logs out and observes the original SSE close and POST 401.
All pending private SDK work is joined before releasing the fixture. The same
Run must complete one real Runtime Tool, reach a quiescent executor and settled
Tool effect, and replay without re-execution. Run and request IDs and the
execution snapshot stay unchanged. The Bash result must show exit code zero,
complete output and an exact ordered file append per Run. A locally interrupted
v1 dispatch may end in error; Run, model and Tool work still require their own
successful evidence.

Each ordinary Run owns a complete Runtime information read under its preparation
span, before catalog listing and model execution. The original request's Agent
and Session and the Run's pinned execution must match the raw HTTP, parse and
close receipts. A v1 prompt may also refresh its catalog after the Run finishes;
that separate read belongs directly to the original RPC and may observe a newer
Runtime execution. All Runtime HTTP work must belong to one of those reads or
to an independently verified catalog or Tool exchange. A closed v1 response
allows only the recorded dispatch-error shape after the refresh has completed;
it does not excuse failed reads, failed closes, Tool cancellation or extra errors.
Session and command collectors select model receipts by the inspected request's
actual Trace ID. A catalog request must still have none; an ordinary Run must
own both expected model stages. Extra same-Trace calls and receipts borrowed
from another Run remain failures.

Read evidence includes the five original discovery-ready, resource-dispatch,
validated, close-started and close-completed events, in that order. Discovery
readiness follows the SDK's parsed response and can precede HTTP SSE EOF.
Closing that same SDK connection can cancel either of its two exact HTTP CLIENTs,
including a successfully parsed discovery response still awaiting EOF. Each
cancellation requires its original AbortError event inside the proved close
interval, a validated resource, no caller cancellation, successful close and
matching HTTP 200 response bytes. Discovery still requires a successful Runtime
transport; this does not admit a canceled discovery SERVER or another read's
cleanup. Both original cancellation records remain in the final report.
Event order is checked by the original timestamps; the backend's event-array
order is retained and need not be chronological.
Each report preserves any deferred same-Node endpoint discrepancy in
`time_observations`, including raw endpoints, Trace and Span IDs and process
identity. Every difference is checked independently and must be strictly below
one millisecond with integer-millisecond start anchors and a direct parent in
the same ACP process. ACP own-span events, same-read ordering and Runtime child
containment remain strict. Runtime events follow the existing
[Jaeger representation rule](../../../contracts/edge-gateway/resolve-cache.md):
safe integer-microsecond start, duration and event fields may represent an event
one microsecond beyond the summed raw end; two microseconds are rejected.
This requires the owned Runtime's Rust OpenTelemetry resource identity and records
each event separately as `jaeger-integer-microsecond-representation`, including
its original array index and raw values. It does not prove nanosecond ordering.
Executor, operation and HTTP completion events must still retain their original
causal order, and cancellation must fall between operation and HTTP completion.
These observations never rewrite timestamps or
change raw warning/error counts, error ownership or `strict_trace`; repeated
outage checks retain each original observation once.

An unavailable prompt may report the original context deadline without an HTTP
wrapper. This still requires the selected, completed Identity CLIENT to have the
same exact deadline receipt, a bounded request budget, the original Gateway
process and ancestry, and no receiver or business execution. A shared decision
may retain `actual-client / shared-deadline` only with its exact source Link and
that completed deadline receipt. Caller cancellation, unfinished shared work,
and unrelated network or DNS errors cannot use this case. The raw error chain
does not identify which context-return branch won the race.

The combined collector retains the original SSE, each independent cause and
denial, and every linked Resolve source. It verifies the exact Gateway-to-UI
parent chain, original CCT, successful token SELECT or bounded cache receipt,
and each later revalidation. Every Gateway CLIENT must be accounted for; two
RPC creators cannot claim one CLIENT, while legitimate shared waiters may reuse
it. Claimed failures must match their exact diagnostics, and unrelated errors
or cancellation fields fail admission. Raw warnings and errors remain strict
failures. Successful protocol requests retain their own private ACP Trace,
request ID, Session ID and Provider evidence. All traces are scanned for
synthetic credentials, including encoded forms. Cleanup joins transports and
database work before telemetry shutdown, including after an earlier closer fails.
Local inspector tests do not replace this profile's actual Docker acceptance.

After all eight original browser streams have closed, explicit SDK clients have
joined, and the admitted Run effects have settled, the client requests a separate
owner-drain window. The runner captures all eight participating services after
Identity's final restoration, binds the unchanged UI and peer processes to the
original deployment, and normally stops only that UI container. A zero exit
with forced-drain or shutdown diagnostics fails. Original Trace collection starts
only after the matching acknowledgement and the normal-stop checks; it cannot
use this later stop as the reason for an earlier browser authorization closure.
The same UI container is restored and observed healthy before the window ends,
including after collection fails or is cancelled. Container lifecycle receipts
do not replace the private ACP close, complete DELETE and watch-join evidence.

Before stopping UI, the runner archives an independent ACP control `/status`
clock sample from the original container, using the same host monotonic clock
as the lifecycle receipts. The collector queries owner closes, workspace DELETEs
and that control probe independently. It archives every original observation,
all eight SSE/cause/denial sets, initialization Links and Resolve sources before
inspecting individual causes. Three identical full snapshots are required;
changed resources, events or warnings restart convergence. Failed responses and
partial bodies remain archived, and cancellation joins the active body before
returning without a verified result.

Every observed SSE belongs to exactly one owner for its original Organization,
User and Agent, including observations that create no additional private request.
The owner must belong to the same UI process, link to its actual initialization,
and retain a complete successful DELETE202 and joined GET/watch inventory.
Each ACP stream end and DELETE boundary must independently fit the calibrated
stop interval. SDK stream callbacks may finish after DELETE; no invented ordering
or rewritten timestamps are used. Each cause revalidates these raw records before
classifying only its own stream diagnostics. Private SDK execution collections
remain separate, and the shared summary counts each raw Span once.

## Evidence and cleanup

Compact final metrics and unmodified raw Traces are kept in private
`artifacts/verification/` directories. `ANTNEST_IDENTITY_EVIDENCE_DIR` must stay
outside `.cache/`, including symbolic aliases and missing descendants.
Identity's diagnostic collector waits for three consecutive equal, validated
snapshots of the entire request/source/trigger closure. A missing source, late
SQL or changed diagnostics resets convergence. Partial raw evidence is retained
on failure. Warnings and errors from every collected Trace remain strict
failures; missing parents are never classified away as clock skew. Cancellation
waits for active request/body reads and inspectors before returning.
[`collectResolveTraceEvidence`](../../support/gateway-resolution-evidence.mjs)
provides this common collection loop and requires an owning business inspector.
The Identity wrapper supplies its default inspector and evidence directory.
Top-level warning/error counts describe the entire raw closure; any overlapping
business diagnostics are retained in `inspector_diagnostics`, including warning
arrays used by CI review. Clean source diagnostics cannot clear a business
inspector's strict failure. This Trace consumer support does not complete #59's
pending fault, display-freshness and
load integration scenarios.
Collectors validate known output files before any HTTP request, and access
clients validate the directory and failure log before login or database setup.
Linked or non-regular output files are rejected, and files are written with
mode 0600.

The coordinator alone operates Docker. The parent owns cleanup of all containers,
volumes and networks, including when a client assertion fails. Test users stay
until the parent removes the disposable databases.
