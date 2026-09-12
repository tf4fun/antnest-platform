# Gateway Identity Closeout

This integration batch exercises the real Edge Gateway, Admin Console BFF and
Identity Service against their disposable Stage 3 PostgreSQL databases. The
default HTTP/SCIM client has no database or Docker access and uses only synthetic
credentials. Business mutations go through Gateway. The separate ACP fault
profile below additionally uses a read-only ACP database connection to verify
that rejected requests and history replay have no durable side effects.

## Scope

1. Local login establishes HttpOnly session cookies without returning the token
   in JSON. Member access, rejected CSRF logout, successful logout and replay of
   the revoked cookie are tested separately.
2. Membership deactivation denies an existing HTTP session and a new login.
   Global User deactivation also revokes issued tokens; reactivation requires a
   new login. This does not claim cancellation of an already-admitted ACP Run.
3. SCIM discovery, read/write scope enforcement, Users and Groups CRUD, filtered
   listing, group membership PATCH, inactive/reactivate, deletion and
   reprovisioning are exercised through `/scim/v2`. Public Location URLs and
   Console directory projections must agree with those mutations.
4. SCIM rotation means issuing a replacement and revoking the old credential.
   Lists must not redisclose secrets; browser cookies do not authorize SCIM.
5. Jaeger assertions require actual parent chains from Gateway through Identity
   to its repository, including Console for administrator mutations. Presence
   of service names alone is not evidence. Passwords, session cookies and SCIM
   credentials must not appear in these traces.

These initial local/SCIM cases do not by themselves cover cross-organization
isolation or expiry; see the separate HTTP access profile below. Already-open
ACP connections are covered separately below; browser UI acceptance remains
separate work. The suites do
not accept the whole C2 or C6 milestone.

## HTTP Access Isolation Batch

`make e2e-identity-access` runs a separate disposable Stage 3 profile. It does
not combine its login attempts with the OIDC/ACP fault profiles or change login
limits. Identity's private RPC is used only to prepare two organizations and
ordinary organization administrators (not system administrators). All access
assertions go through Gateway; no database rows or clocks are modified.

The same email is provisioned with separate identities/passwords in each
organization. Tests compare directory and SCIM projections, reject foreign
resource mutation and forged scope headers/body fields, and exercise password
rotation and logout independently. Password change currently preserves issued
sessions; logout revokes only the presented session. Tests must describe these
semantics explicitly rather than infer revocation from a successful password
change response.
The password-command assertions distinguish BFF `401 invalid_current_password`
(no session cookie mutation, subsequent access succeeds) from Gateway
`401 unauthenticated` after real token expiry (both session cookies cleared,
the password is not changed). Console's API/App tests consume these same error
codes and verify dialog retention versus returning to login, including late
responses from an older in-page session.

Finally the coordinator stops only Identity, proving protected requests return
503 without deleting cookies. It restores Identity with the existing token TTL
configuration set to five seconds for new tokens only: the prior long-lived
cookie must recover, while a new short-lived cookie must pass before its stated
deadline and fail after it, even when manually replayed. A fresh login must
work afterward. This is not browser cookie eviction or a forged expired record.
The short TTL override never enters deployment Compose. The profile always
cleans its containers/volumes/networks; keep-stack is not supported.

HTTP logout/expiry evidence must not be claimed as WebSocket token revocation.

## Agent Organization Access Batch

`make e2e-agent-access` is an independent disposable profile. Identity's owning
RPC prepares two organizations, separate organization administrators and one
User who is an administrator in A and a member in B. All subsequent Agent,
catalog, membership and ACP actions enter through Gateway. Each organization
has its own model configuration, Template and Agent; both Agents have the same
User owner, so user-only filtering cannot accidentally pass the test.

The acceptance matrix covers scoped administrator lists/details/operations and
events (including watch rejection), rejected foreign lifecycle commands,
forged organization/role headers and body/query scope, member versus admin
surfaces, owner-only workspace lists and v1/v2 upgrades. Within an authorized
connection to one's local Agent, foreign Session load/resume, fork, close,
delete and prompt must fail without history or persisted effects. Deactivating
only B's Membership must reject B's already-open connection without invalidating
the same User in A. The Controller must finish automatic Disable before
restoration is tested. Restoring B preserves the disabled Agent; only explicit
Enable permits reconnecting with the still-valid token and replaying history.

The same profile accepts C2-05 owner offboarding. It checks both protocol
versions, global User deactivation across A/B, an unaffected second owner,
and SCIM Membership deletion. Business mutations enter Gateway. Runtime's
own inspection API independently confirms `disabled/absent`, and a sentinel
seeded/read through the official MCP client proves workspace retention after
Enable. The test client joins the Runtime management network only for this
fixture oracle; product routing/permissions do not change. Existing ACP-owned
read-only snapshots prove that Disable does not delete history or Runs.
After explicit Enable, fresh Gateway ACP Runs prove that admission and the
shared model credential still work. The SCIM owner logs in through the same
real OIDC flow/HTTPS fixture used below, has a peer Membership/Agent in A, and
owns nonempty chat history in B before deletion. A must remain usable while B
is disabled; reprovisioning keeps the User, creates a new Membership, and
permits old Session replay and a new Run only after explicit Enable. The
owning Identity RPC prepares A's peer Membership; no SQL writes are used.
The coordinating shell stops Controller before the global revocation and
restarts it afterward. The committed event must be consumed after restart
without duplicating earlier offboarding. The client only requests named
checkpoints; it has no Docker socket or lifecycle process permissions.

Jaeger evidence must connect each source Gateway request to Identity receipt,
Controller scheduling and every Disable worker phase using exact parent/link
IDs. Runtime Controller and Egress control RPC must descend from their matching
worker phase, including the mutating method/route (Inspect is insufficient).
Unrelated spans or service-name presence cannot pass. This does
not test packet tracing, mid-Disable crash recovery, emergency cancellation or arbitrary
unavailable Runtime convergence. Temporary containers/volumes are cleaned by
the parent, and only compact final metrics are retained.

Official SDKs drive both protocol versions. A local model fixture verifies the
organization-specific credential and context before answering; positive Runs
must persist and replay their private history. Denials must leave owner-side
Agent/catalog/event projections and ACP tables unchanged, with no model calls.
Authorized load/resume replaces one client MCP revision for the requested
Session: the oracle checks the new revision and pointer while preserving all
older revisions, other Sessions, Runs and messages. This is not a blanket
exemption for Session-table writes. Model input and replay both reject foreign
history, even when the expected own answer is present too.
The replay oracle also compares ordered message IDs and content with persisted
history. Error replies and revocation notifications must not disclose history;
context checkpoints are included in the no-mutation snapshot.
The test client reads only ACP-owned tables for this negative-effect oracle;
product services do not gain database access across ownership boundaries.
Jaeger assertions also check actual Gateway ancestry for Console/Controller
access decisions and ACP model requests. No real Provider or browser UI
acceptance is implied by this profile.

## ACP Browser Session Batch

The default Stage 3 suite also runs `acp-session-client.mjs` in the official SDK
client image, against real Gateway, Identity and ACP services. For each explicit
v1/v2 route it creates a Session, completes browser logout through Gateway, then
submits a prompt on the original WebSocket. The request must fail with close
1008. A new login must load/resume the same Session with no rejected prompt or
Run events in its history. These are synthetic credentials and a local model
fixture, not an external Provider test. Gateway-rooted Identity repository
traces are checked for parent chains and credential disclosure.

The service relay tests separately cover identity changes, dependency failure,
timeout, fragmented/pipelined messages, bounded capacity and shutdown cleanup.
Real post-upgrade natural expiry and dependency-outage recovery use the
separate fault profile below. No test claims immediate idle-socket revocation or automatic
cancellation of already-admitted Runs.

## Existing ACP Connection Fault Profile

`ANTNEST_E2E_ACP_SESSION=true sh scripts/e2e-stage3a.sh` is a separate disposable
profile (not compatible with keep-stack or the other fault profiles). It creates
one synthetic owner/Agent through Gateway. Official v1/v2 SDK clients establish
connections before the coordinator stops only Identity. A prompt on each old
connection must close with 1013 without any durable Run/message/Tool mutation.
The same long-lived cookies must reconnect after Identity recovery.

An empty recovered Session must contain its current command catalog and, for
v2 replay only, exactly one idle control update. Reuse `assertEmptySession`
from the ordinary logout profile: an all-`state_update` predicate incorrectly
rejects valid catalogs while accepting an empty response. User messages, Tool
activity, execution state and duplicate catalogs remain failures. Identity ACP
clients use the shared bounded connection helper and the SDK's
`cancellationSignal` option; socket errors are observed and no upgrade retry is
silently introduced.

The coordinator then starts Identity with its existing five-second token TTL
setting. New connections must work before their issued deadlines and reject
prompts with 1008 after natural expiry, without changing DB rows or clocks.
Previously issued long-lived credentials remain usable. Deployment Compose is
unchanged; the normal TTL is restored before the last scenario.

For already-admitted work, a local model fixture holds a real request. Only after
the Run is running does the client log out and force old-connection rejection.
Releasing the fixture must let that same Run complete one real Runtime Tool,
release its admission and resume without replay on reconnect. The structured
Bash result must show exit code zero, complete output and an exact ordered file
append per Run; a marker in an error or arbitrary result text cannot pass.
Both rejected-message and execution traces scan the current synthetic cookies
and model credential, including URL-encoded forms.
This tests browser-session revocation/disconnect,
not owner/Agent deactivation or indefinite execution during an Identity outage.
The coordinator alone operates Docker; the SDK client only requests named
checkpoints. Its ACP-owned database connection is read-only and serves as a
negative-effect oracle, not a cross-service product dependency. Final output
contains counts and trace assertions, never credentials or intermediate dumps.

## Run

`make e2e-stage3` builds and runs the disposable stack, including this client.
After images are already built, `sh scripts/e2e-stage3a.sh` runs the same suite.
The parent owns resource cleanup, including when a client assertion fails.

The client is invoked by the parent as:

```sh
node scripts/identity-closeout/client.mjs "$gateway_url" "$jaeger_url"
```

It requires a Stage 3 synthetic administrator and creates uniquely named test
users, groups and tokens. Do not point it at production. Test users intentionally
remain until the parent removes the disposable databases. All HTTP requests are
bounded; there are no background workers or external Providers. The output is
compact final counts and trace summaries, not a dump of credentials or payloads.

`node --test --test-concurrency=1 scripts/identity-closeout/*.test.mjs` tests the
HTTP/assertion helpers. These helper tests are not substitutes for the real
integration run. Formatting and fixture tests are part of the root Make gates.

## OIDC Gateway Batch

Stage 3 also starts a disposable HTTPS IdP fixture. It implements discovery,
authorization-code redirects, one-use code redemption with exact client and
redirect binding, PKCE S256, and RSA-signed ID tokens verified via JWKS by the
real Identity service. This fixture auto-authenticates selected synthetic
accounts; it is not acceptance of a particular vendor's IdP login UI.

The test-only Compose override trusts a fresh, one-day certificate through
`SSL_CERT_FILE`. TLS verification is never disabled. The host test client maps
the fixture DNS name to its loopback-published port while preserving certificate
hostname verification. Neither this CA nor the fixture is enabled in deployment
Compose. A shared named test certificate volume allows keep-stack restarts;
normal teardown removes it together with the fixture.

The OIDC suite exercises SCIM/local account convergence, stable subject binding,
inactive and unknown-account rejection, refusal to federate system admins,
wrong nonce rejection, browser-transaction transfer denial before token
exchange, callback replay and concurrent-start replacement. Provider disable
and secret rotation are verified against real discovery/exchange. Gateway-rooted
start/callback traces and service logs are checked for synthetic secrets.
All provisioning and login requests enter Gateway, with no direct SQL writes.
The fixture's counters are only a protocol-execution oracle.

Trace acceptance also requires exact successful IdP HTTP client spans under the
same Identity request as its owned persistence. Provider registration covers
Discovery; login callback covers Token and JWKS. A separate `/profile` issuer
returns an ID token without email and exposes authenticated UserInfo, proving
the fallback path without changing the existing denial issuer. The fallback
must converge to the same provisioned User and Membership.

Each expected method/endpoint must have one finished client span, successful
status and a same-trace parent chain whose nearest Identity server span is the
same one that owns persistence. An outbound client span cannot substitute for
that server span. Missing,
detached, foreign-request, duplicate or failed spans must fail the verifier.
Compact summaries contain method, path and span identity, never credentials or
response bodies. Transport errors (including nested causes) and JSON parser
errors cannot redisclose raw Gateway, Jaeger or IdP fixture responses.

The denial cases use a second issuer path, respecting Identity's one-issuer-per-
organization registration rule. Re-login with the same subject but a changed
email must retain the original User/Membership, rather than re-link by email.
Test-only evidence endpoints expose synthetic PKCE verifiers, signed ID tokens
and Basic credentials to the coordinator's scanner, never to product clients.
Trace and log scans include these canaries and URL-encoded forms. Logs must
contain correlated request records from Gateway, Console and Identity; empty
or startup-only output cannot pass. Failure diagnostics print only bounded
service/level counts, never raw logs, callback URLs or credential values.
