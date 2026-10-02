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

| Command | Profile |
| --- | --- |
| `make e2e-identity-core` | Local login, SCIM and OIDC |
| `make e2e-identity-access` | HTTP access isolation, Identity outage and token expiry |
| `make e2e-agent-access` | Agent organization access and owner offboarding |
| `make e2e-acp-session` | Browser logout and Identity faults on existing ACP connections |

All targets require Docker and the local Stage 3 images
(`make docker-build-stage3`). Each profile is independent and must not be
combined with another fault profile or `ANTNEST_E2E_KEEP_STACK=true`. The fixture
helpers run without Docker as part of `make test`:

```sh
node --test --test-concurrency=1 tests/e2e/identity-closeout/*.test.mjs
```

Helper tests do not replace the real integration run.

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
this producer regression does not yet prove the Node/SSR/browser consumer #93.
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` similarly selects a current RC dependency
image (including its Skill preparer) when the local tag has fallen behind
deployment changes. Both overrides apply only to this disposable profile.

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
   Identity to its repository, including the Console for administrator
   mutations. Service names alone are not evidence. Passwords, session cookies
   and SCIM credentials must not appear in Traces.

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

The same email is provisioned with separate identities and passwords in each
organization. Tests compare directory and SCIM projections, reject foreign
resource mutation and forged scope headers or body fields, and exercise password
rotation and logout independently. A password change preserves issued sessions,
and logout revokes only the presented session; tests state these semantics
explicitly. The password command assertions distinguish BFF
`401 invalid_current_password` (no session cookie change, later access succeeds)
from Gateway `401 unauthenticated` after real token expiry (both session cookies
cleared, password unchanged). Console API and App tests consume the same error
codes and verify dialog retention versus returning to login, including late
responses from an older in-page session.

Finally the coordinator stops only Identity and proves that protected requests
return 503 without deleting cookies. It restarts Identity with the token TTL set
to five seconds for new tokens: the earlier long-lived cookie must recover, and a
new short-lived cookie must work before its deadline and fail after it, even when
replayed manually. A fresh login must then work. The short TTL override exists
only in the fixture Compose. HTTP logout and expiry results are not WebSocket
token revocation results.

## Agent organization access and offboarding

`make e2e-agent-access` uses Identity's RPC to prepare two organizations,
separate organization administrators and one User who is an administrator in A
and a member in B. All later Agent, catalog, membership and ACP actions go
through the Gateway. Each organization has its own model configuration,
Template and Agent, and both Agents have the same User owner, so user-only
filtering cannot pass by accident.

The access matrix covers scoped administrator lists, details, operations and
events (including watch rejection), rejected foreign lifecycle commands, forged
organization and role headers and body or query scope, member versus
administrator surfaces, owner-only workspace lists and v1 and v2 ACP
authorization. The Gateway authenticates the connection; ACP rejects
unauthorized Agent requests with `access_denied`. Within an authorized
connection to a local Agent, foreign Session load, resume, fork, close, delete
and prompt must fail without history or persisted effects. Deactivating only
B's Membership must reject B's already-open connection without invalidating the
same User in A. The Controller must finish automatic Disable before restoration
is tested. Restoring B keeps the Agent disabled; only an explicit Enable allows
reconnecting with the still-valid token and replaying history.

Owner offboarding is checked for both protocol versions: global User
deactivation across A and B, an unaffected second owner, and SCIM Membership
deletion. The Runtime's own inspection API confirms `disabled/absent`, and a
sentinel seeded and read through the official MCP client proves workspace
retention after Enable. The test client joins the Runtime management network
only for this oracle. ACP-owned read-only snapshots prove that Disable does not
delete history or Runs. After explicit Enable, fresh Gateway ACP Runs prove that
admission and the shared model credential still work.

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

**Logout.** For each v1 and v2 route, the client creates a Session, completes
browser logout through the Gateway, then submits a prompt on the original
WebSocket. The request must fail with close code 1008. A new login must load or
resume the same Session with no rejected prompt or Run events in its history.

**Identity outage.** Official v1 and v2 clients connect before the coordinator
stops only Identity. A prompt on each old connection must close with 1013
without any durable Run, message or Tool change, and the same long-lived cookies
must reconnect after Identity recovers. An empty recovered Session must contain
its current command catalog, one untitled Session info update with a valid
timestamp and, for v2 replay only, exactly one idle control update
(`assertEmptySession`). User messages, Tool activity, execution state and
duplicate catalogs are failures. Clients use the shared bounded connection
helper and the SDK's `cancellationSignal`; socket errors are observed, and no
upgrade retry is introduced.

**Expiry.** The coordinator restarts Identity with a five-second token TTL. New
connections must work before their deadlines and reject prompts with 1008 after
natural expiry, without changing database rows or clocks. Earlier long-lived
credentials keep working. The normal TTL is restored before the last scenario.

**Admitted work.** A local model fixture holds a real request. Only after the
Run is running does the client log out and force rejection on the old
connection. Releasing the fixture must let the same Run complete one real
Runtime Tool, finish with a quiescent executor and a settled Tool effect, and
resume without re-execution on reconnect. The Run and request IDs and the
captured execution snapshot stay unchanged. The structured Bash result must
show exit code zero, complete output and an exact ordered file append per Run.

Each rejected message has its own Gateway root linked to the connection.
Successful requests bind the SDK request ID and returned Session ID, and
execution binds the Provider HTTP span IDs. Traces are scanned for the synthetic
cookies and model credential, including URL-encoded forms. The service relay
unit tests separately cover identity changes, dependency failure, timeout,
fragmented and pipelined messages, bounded capacity and shutdown cleanup. No
test claims immediate revocation of idle sockets or automatic cancellation of
admitted Runs.

## Evidence and cleanup

Compact final metrics and unmodified raw Traces are kept in private
`artifacts/verification/` directories. `ANTNEST_IDENTITY_EVIDENCE_DIR` must stay
outside `.cache/`, including symbolic aliases and missing descendants.
Collectors validate known output files before any HTTP request, and access
clients validate the directory and failure log before login or database setup.
Linked or non-regular output files are rejected, and files are written with
mode 0600.

The coordinator alone operates Docker. The parent owns cleanup of all containers,
volumes and networks, including when a client assertion fails. Test users stay
until the parent removes the disposable databases.
