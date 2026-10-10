# Gateway request header boundary

This contract defines the reserved namespaces and outbound request allowlists
for #63. It extends the [session contract](session-contract.json) without
changing Identity authority, session-bound CSRF, or the
[public-entry trust boundary](public-entry.md).

## Inbound reserved namespaces

Before routing, remove every browser header beginning with `X-Antnest-` or
`Antnest-`, case-insensitively, including unknown future names and duplicate
fields. Capture only the existing CSRF and account-switch preconditions in
private request context before removal. Neither capture grants authority.

`X-Antnest-CSRF-Token` is Gateway-local and never forwarded. The authenticated
session determines its expected value. `X-Antnest-Expected-Principal` is
compared with authenticated Identity facts only for
`PUT /api/admin/agents/{agent_id}/network-policy`; a successful comparison
regenerates one canonical field for Console. All other routes discard it.

## Outbound allowlists

Every proxy starts with a fresh header map. Copy only the standard or protocol
fields declared for its route family, after HTTP hop-by-hop filtering. A
browser `Connection` nomination must not cause a removed field to be copied
back from the original request. Add verified principal hints, caller context,
workload authentication and public forwarding metadata separately.

No route accepts browser request trailers. Every HTTP proxy clears the outbound
`Trailer` map, including values supplied only after the body is read. Preserve
the body and let the transport select its ordinary framing; clearing the header
map alone does not remove trailers.

The asset profile contains `Accept`, `Accept-Encoding`, `Cache-Control`,
`If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`,
`If-Range` and `Range`. The JSON profile contains `Accept`, `Content-Type`,
`If-Match` and `Idempotency-Key`. Preserving a conditional field does not add
ETag or concurrency semantics to a consumer that does not implement them.

| Route family                                             | Browser fields forwarded                                                            | Identity added by Gateway                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Console HTML/assets                                      | Asset profile                                                                       | Workload authentication only                                                                              |
| Admin JSON API                                           | JSON profile; Idempotency-Key also survives receipt lookup GETs                     | Console CCT and the five existing principal hints                                                         |
| Admin event watch                                        | Accept, Last-Event-ID                                                               | Console CCT and principal hints                                                                           |
| Admin network-policy PUT                                 | JSON profile                                                                        | Console CCT, principal hints and the server-generated canonical Expected-Principal after local validation |
| Workspace SSR HTML                                       | Accept                                                                              | Workspace CCT and organization-scoped presentation hints                                                  |
| Workspace assets                                         | Asset profile                                                                       | Workload authentication only                                                                              |
| Workspace JSON API                                       | JSON profile                                                                        | Workspace CCT, presentation hints and an Agent ID where the route selects one                             |
| Workspace event stream                                   | Accept, Last-Event-ID                                                               | Workspace CCT, presentation hints and route Agent ID                                                      |
| ACP HTTP/SSE                                             | Accept, Content-Type, Acp-Connection-Id, Acp-Session-Id                             | ACP CCT and existing route-scoped principal hints                                                         |
| ACP WebSocket, including aliases and versions            | Subprotocol selection through the WebSocket library; no raw browser identity fields | ACP CCT and route-scoped hints; library-generated handshake fields                                        |
| SCIM                                                     | Accept, Content-Type, Authorization, If-Match, If-None-Match                        | Workload authentication only; Identity validates the SCIM bearer                                          |
| Local session/login/OIDC/bootstrap/state/status handlers | No raw header forwarding; typed downstream clients construct requests               | Existing server-selected RPC credentials and context                                                      |

Only the declared ACP routes forward WebSocket protocol selection. Generic
Console, asset, Workspace and SCIM HTTP proxies do not forward a browser
upgrade handshake.

`Cookie` never reaches an upstream. Browser `Authorization` reaches only SCIM.
The existing telemetry transport extracts incoming trace context and injects
the outgoing context; raw tracing headers are not proxy allowlist entries and
`Baggage` is removed. HTTP transport owns Host and message framing. Gateway
rebuilds `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` from the
resolved client address and configured public origin.

## Namespace inventory and admission

The machine-readable registry must distinguish browser-local input, a
validated precondition, injected presentation hints, internal credentials and
execution fences, response-only metadata, and retired names. An internal or
response-only header is not a browser exception. Principal hints are display
compatibility fields; receiving services authenticate signed caller context.

The [registry](request-headers.json) is the source for the generated attack
vocabulary in Gateway tests and the session contract's hint projections.
Run `node tests/support/check-trusted-headers.mjs` to check the repository;
the same check runs through the repository test gate.

Inventory checks cover Go, TypeScript/TSX and Rust production sources in all
services, runtimes and shared modules, including browser senders and named
constants. Tests, generated output and comments do not introduce production
header names. A new reserved name requires an explicit registry decision.
Names must use complete string literals, including declarations of named
constants. The check inventories vocabulary; it does not prove arbitrary
runtime string construction. [Non-header vocabulary](non-header-vocabulary.json)
contains exact complete values and one source-scoped multipart boundary template,
with no prefix exemptions. These entries affect source inventory only; every
matching browser field is still stripped at runtime.

Gateway tests send the entire registered vocabulary and unknown future names
through each route family with valid Origin, session and CSRF admission. They
assert that the upstream is reached and receives only that family's declared
fields and verified injected values. Consumer compatibility and HTTPS browser
integration follow the Gateway service batch; one producer test does not
complete the end-to-end admission.
