# Gateway service admission and caller forwarding (#26)

This owning-service batch implements the
[platform token and CCT contract](../platform/service-authentication.md).
Consumer gates were admitted as separate owning-service batches, followed by
complete token-profile Docker integration. The
[rollout ledger](../platform/service-authentication-rollout.json) records both.

The public Gateway listener and local `/status` retain their public catalog
policy. Gateway 24 internal dependencies are Identity, Console and Agent UI. Startup requires the exact shared authentication mode and validates each
configured dependency's token file. Token mode also validates Gateway's receiver
hash file (normally `{}`); Gateway exposes no internal workload business route.
There is no legacy unauthenticated client configuration.

All internal HTTP connections pin the configured receiver origin.
Redirects are disabled. Credentials are selected from a server-owned service
name and reloaded for each new request. Missing or invalid replacement
files fail that request; a previously loaded token is never reused. TLS uses the
platform CA, the dependency URL's DNS name and the receiver's exact service URI.
Complete shared TLS configuration validates Gateway's own certificate identity;
`ANTNEST_TLS_SERVER_NAME` describes that certificate, not every dependency's
name. Only mTLS sends the Gateway client certificate. Plain internal HTTP is
limited to the explicit disposable-development token opt-in.

The session cookie is resolved over the authenticated Identity connection for
each initial operation. The actual server route selects the fixed profile:

| Route                                         | Profile     | Agent scope                                                                   |
| --------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `/api/session` and protected session controls | `session`   | None                                                                          |
| `/api/admin/{path...}`                        | `console`   | Agent from `/agents/{agent}/...`; other administration is organization-scoped |
| Bridge bootstrap                              | `workspace` | None                                                                          |
| Workspace HTML `/workspace/{agent}/...`       | `workspace` | None: SSR renders the discovery shell; operations use scoped API routes       |
| Workspace Bridge `agents/{agent}/...`         | `workspace` | Agent from the Bridge path                                                    |

Gateway consumes Identity revision 18's nonempty bounded `caller_context`, keeps
it in a private request context and forwards it unchanged in exactly one
`Antnest-Caller-Context` field. Gateway trusts the authenticated issuer response;
each consuming service verifies the CCT signature, audience and target scope.
Identity principal fields remain the authority for Gateway's session/CSRF/admin
checks. No profile or Agent scope comes from a browser header, query or body.

The entire case-insensitive `X-Antnest-*` and `Antnest-*` namespaces are removed,
including both internal credentials and unknown future names. The Gateway-owned CSRF
value is retained privately for comparison with the session-bound HMAC and never
forwarded; the delivery cookie itself is not proof of CSRF admission.
`X-Antnest-Expected-Principal` is also retained privately as an account-switch
CAS precondition. Only `PUT /api/admin/agents/{agent}/network-policy` compares
its single URI-encoded organization/user pair with authenticated Identity facts.
Missing, duplicate, malformed or mismatched values return `409 principal_changed`
before proxying; a match regenerates one canonical header for Console's own
comparison against signed claims. It cannot select authority and is removed from
all other routes.
Every HTTP proxy uses the [route header allowlists](request-headers.md) after
hop-by-hop filtering and discards request trailers. Verified principal hints,
CCT and the validated canonical CAS value are injected independently from
private context; browser `Connection` fields cannot remove that authority or
restore an already filtered browser header.
Only verified principal presentation hints are regenerated where the existing
UI contract requires them; receivers must not use these hints as authentication.
Public assets and SCIM requests receive workload authentication but no CCT;
SCIM's own `Authorization` bearer is preserved. Internal credential response
headers are removed before writing browser responses. CCTs never enter browser
JSON, URLs, logs or trace content.

Retained Bridge/admin SSE observers keep bounded leases, scoped non-touch
Identity checks, source-age/cache/feed proof and original session identity and
absolute expiry. A current returned CCT must remain valid; fresh live resolution
can observe new idle eligibility and a new CCT without changing that original
identity. Closing observation does not cancel accepted execution. Browser
activity and account controls remain defined by the
[session lifecycle](../identity/browser-sessions.md).

The obsolete direct Gateway caller is retired separately at Controller and ACP.
Agent UI still needs its workload callers and Identity workspace CCT audiences
for those services. Removing Gateway URLs and outgoing files does not revoke
receiver grants or complete deployment migration.
