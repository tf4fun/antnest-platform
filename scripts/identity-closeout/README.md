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

OIDC IdP login/callback, cross-organization protocol isolation, token expiry,
already-open ACP connections and log-sink inspection remain separate acceptance
work. This batch does not accept the whole C2 or C6 milestone.

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
