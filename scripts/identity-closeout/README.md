# Gateway Identity Closeout

This integration batch exercises the real Edge Gateway, Admin Console BFF and
Identity Service against their disposable Stage 3 PostgreSQL databases. Every
business mutation goes through Gateway HTTP; the client has no database or
Docker access and uses only synthetic credentials.

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
ACP connections and browser UI acceptance remain separate work. The suites do
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

Finally the coordinator stops only Identity, proving protected requests return
503 without deleting cookies. It restores Identity with the existing token TTL
configuration set to five seconds for new tokens only: the prior long-lived
cookie must recover, while a new short-lived cookie must pass before its stated
deadline and fail after it, even when manually replayed. A fresh login must
work afterward. This is not browser cookie eviction or a forged expired record.
The short TTL override never enters deployment Compose. The profile always
cleans its containers/volumes/networks; keep-stack is not supported.

Already-upgraded ACP WebSockets remain a separate gap: identity/Agent admission
is revalidated, but the originating browser token is not carried across upgrade.
HTTP logout/expiry evidence must not be claimed as WebSocket token revocation.

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

The denial cases use a second issuer path, respecting Identity's one-issuer-per-
organization registration rule. Re-login with the same subject but a changed
email must retain the original User/Membership, rather than re-link by email.
Test-only evidence endpoints expose synthetic PKCE verifiers, signed ID tokens
and Basic credentials to the coordinator's scanner, never to product clients.
Trace and log scans include these canaries and URL-encoded forms. Logs must
contain correlated request records from Gateway, Console and Identity; empty
or startup-only output cannot pass. Failure diagnostics print only bounded
service/level counts, never raw logs, callback URLs or credential values.
