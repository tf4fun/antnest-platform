# Gateway service admission and caller forwarding (#26)

This owning-service batch implements the
[platform token and CCT contract](../platform/service-authentication.md).
Consumer gates were admitted as separate owning-service batches, followed by
complete token-profile Docker integration. The
[rollout ledger](../platform/service-authentication-rollout.json) records both.

The public Gateway listener and local `/status` retain their public catalog
policy. Internal dependencies are Identity, Console, Agent UI, Controller and
ACP. Startup requires the exact shared authentication mode and validates each
configured dependency's token file. Token mode also validates Gateway's receiver
hash file (normally `{}`); Gateway exposes no internal workload business route.
There is no legacy unauthenticated client configuration.

All internal HTTP and WebSocket connections pin the configured receiver origin.
Redirects are disabled. Credentials are selected from a server-owned service
name and reloaded for each new request/connection. Missing or invalid replacement
files fail that request; a previously loaded token is never reused. TLS uses the
platform CA, the dependency URL's DNS name and the receiver's exact service URI.
Complete shared TLS configuration validates Gateway's own certificate identity;
`ANTNEST_TLS_SERVER_NAME` describes that certificate, not every dependency's
name. Only mTLS sends the Gateway client certificate. Plain internal HTTP is
limited to the explicit disposable-development token opt-in.

The session cookie is resolved over the authenticated Identity connection for
each initial operation. The actual server route selects the fixed profile:

| Route                                   | Profile     | Agent scope                                                                                         |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `/api/admin/{path...}`                  | `console`   | Agent from `/agents/{agent}/...`; other administration is organization-scoped                       |
| Workspace bootstrap and `/api/session`  | `workspace` | None                                                                                                |
| Workspace HTML `/workspace/{agent}/...` | `workspace` | None: SSR renders the organization discovery shell; Agent operations use separate scoped API routes |
| Workspace bridge `agents/{agent}/...`   | `workspace` | Agent from the bridge path                                                                          |
| Workspace execution state/watch         | `workspace` | Agent from the route                                                                                |
| Direct ACP HTTP/WebSocket               | `acp`       | Agent from the route                                                                                |

Gateway requires Identity revision 14's nonempty bounded `caller_context`, keeps
it in a private request context and forwards it unchanged in exactly one
`Antnest-Caller-Context` field. Gateway trusts the authenticated issuer response;
each consuming service verifies the CCT signature, audience and target scope.
Identity principal fields remain the authority for Gateway's session/CSRF/admin
checks. No profile or Agent scope comes from a browser header, query or body.

Incoming `Antnest-Service-Authorization`, `Antnest-Caller-Context` and the entire
case-insensitive `X-Antnest-*` namespace are removed. The one Gateway-owned CSRF
value is retained privately for local cookie comparison and never forwarded.
`X-Antnest-Expected-Principal` is also retained privately as an account-switch
CAS precondition. Only `PUT /api/admin/agents/{agent}/network-policy` compares
its single URI-encoded organization/user pair with authenticated Identity facts.
Missing, duplicate, malformed or mismatched values return `409 principal_changed`
before proxying; a match regenerates one canonical header for Console's own
comparison against signed claims. It cannot select authority and is removed from
all other routes.
Only verified principal presentation hints are regenerated where the existing
UI contract requires them; receivers must not use these hints as authentication.
Public assets and SCIM requests receive workload authentication but no CCT;
SCIM's own `Authorization` bearer is preserved. Internal credential response
headers are removed before writing browser responses. CCTs never enter browser
JSON, URLs, logs or trace content.

Existing bounded observation leases and per-message user-session revalidation
remain. The direct WebSocket handshake CCT also bounds admission of new client
messages: after its 60-second issuer lifetime the connection closes and must
reconnect. This does not cancel accepted ACP work. In-place renewal and immediate
long-lived stream revocation belong to #58; no custom `session/refresh` protocol
is added here.
