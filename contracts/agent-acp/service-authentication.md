# ACP workload and caller context (#26/#27)

The [platform contract](../platform/service-authentication.md) fixes the token,
mTLS and signed CCT profiles. This owning-service contract adds listener placement.

`ANTNEST_ACP_LISTEN` (default `:8080`) serves ACP, signed workspace observation,
Console audit and Registry source reads. `ANTNEST_ACP_CONTROL_LISTEN` (default
`:8081`) serves only `POST /rpc/agent-acp/apply-execution-snapshot`,
`POST /rpc/agent-acp/settle-agent`, `POST /rpc/agent-acp/get-runtime-barrier` and
minimal `GET /status`. The workspace listener returns 404 for these Controller
paths, including unsupported methods
and query variants, before reading their bodies. The control listener returns
404 for every other path and denies WebSocket upgrades. State get/watch remain
on the workspace listener for Agent UI.

The [unused Gateway caller retirement](../edge-gateway/workspace-entry-retirement.md)
removes Gateway from all eleven workspace route grants: private ACP v1 HTTP,
v1/v2 WebSocket, state, learning and Bridge observation. A configured valid old
Gateway credential receives `403 caller_not_allowed` before CCT/JWKS verification
or business work. The workload identity remains recognized; an unknown token is
still a separate `401`. Agent UI retains its signed ordinary-member access and
the Identity workspace CCT audience. Private protocol routes, Controller control,
Console audit, Registry operations and public health remain. Purpose-listener
isolation still returns 404 before authentication on the wrong listener.
Deployment credential/network cleanup and browser integration are later batches.

Control calls require verified `agent-controller` workload identity. There is
no separate legacy control bearer, no user CCT, and no body-selected caller.
Missing or invalid workload credentials return 401 `service_unauthenticated`
with the token challenge; a verified wrong service returns 403
`caller_not_allowed`. The accepted snapshot revision cannot move backwards.

Both listeners use the same mandatory shared token/mTLS configuration; startup
opens both before reporting readiness and closes both if either bind fails.
Deployment must bind them to their separate caller networks, not merely attach
a wildcard listener to several networks. That wiring, authenticated Controller
client adoption and final token-profile integration are admitted in the
[rollout ledger](../platform/service-authentication-rollout.json).

The optional `ANTNEST_ACP_OWNER_LISTEN` is a third, independent listener for
`POST /internal/acp-owner/incarnation/probe`. It admits only Runtime Controller
workload identity, without user CCT or Identity/PostgreSQL dependencies. Its
exact route grant and deny fallback are in [the caller catalog](callers.json).
Authentication precedes body parsing; unknown credentials return 401 and a
verified different workload returns 403. The existing workspace and control
listeners do not serve this route. Request and response bodies follow the
[incarnation wire contract](owner-handoff.md#trusted-incarnation-registration), including its
size bounds, deadlines, closed DTOs, `no-store` and payload-capture prohibition.
Outbound registration uses the fixed `ANTNEST_ACP_RUNTIME_CONTROLLER_URL` with
Runtime Controller's receiver-specific workload credential only. This startup
gate preserves the global worker lock; peer forwarding and multi-replica
deployment remain separate admission work.

ACP and workspace routes require exactly one Identity-signed CCT with ACP
audience and `agt`, then repeat current local Agent and Session authorization.
Audit calls additionally require Console workload and a signed organization-scoped
administrator. Controller operations and Registry source reads rely on their
exact workload allowlist and retain their existing operation checks.
Unsigned `X-Antnest-*` fields never select authority.

Identity JWKS is read only through the configured, authenticated
`ANTNEST_ACP_IDENTITY_URL` origin. Token files are validated before listening
and reread per outgoing request. Optional Controller learning-policy and Registry
clients use their separate fixed origins and per-receiver credentials. Runtime
outbound authentication uses the admitted RC-owned
[private instance connection](../runtime/instance-connection.md);
execution fences and maintenance tickets remain mandatory.

Expired CCTs reject new HTTP requests and new WebSocket methods. A WebSocket
closes with 1008 and `caller_context_expired`; already accepted model work is
not cancelled, and permission replies for accepted work may settle. Long-lived
renewal belongs to #58. No new ACP refresh frame is introduced.

JSON POSTs require one `application/json` content type with only optional UTF-8
charset. Strict UTF-8, duplicate members, extra documents and exact-case domain
schemas are checked before effects; malformed JSON returns 400, oversized bodies
413 and unsupported media/encoding 415. The SDK still owns ACP connection IDs,
message routing and SSE. The authenticated Node adapter joins the SDK's close
operation before acknowledging a valid DELETE. Rejected DELETE bodies cannot
close an accepted SDK connection. Credentials and CCTs are not persisted or captured in
logs, trace attributes or RPC content.

## Private HTTP transport retirement

For `/v1/acp`, a valid empty-body DELETE of a known connection returns 202 only
after its SDK transport cleanup completes. A server-initiated close can precede
the client's automatic DELETE; ACP retains that connection's immutable
organization, principal and Agent binding and the original cleanup result for
up to five minutes. This is a process-local cleanup acknowledgement, not a new
ACP method or a durable Session or Run receipt. It never deletes a Session or
cancels a Run.

Every acknowledgement still requires the admitted Agent UI workload and a valid
Identity-signed CCT for the same binding. Another binding receives 403. An unknown
or expired connection ID receives 404; a retained cleanup failure receives 503,
not 202. GET and POST cannot use a retired connection. DELETE body validation
remains in force: a nonempty body is 400 and an oversized body is 413, without
consuming the acknowledgement or extending its deadline. Clients continue to
await the complete DELETE response and preserve non-202 failures.

Initializations, live connections, pending cleanup and retained acknowledgements
share the existing 1024-entry limit. Concurrent admitted DELETE requests join
the same cleanup operation. A completed successful acknowledgement removes its
ID, but the entry remains owned and counted until cleanup and all already
admitted responses finish. Their original retirement deadline remains in force;
other requests never renew it. Expiry removes the ID and aborts outstanding
responses, but pending cleanup retains its capacity until it settles. Idle expiry,
failed initialization and forced shutdown do not create new acknowledgements.
Late SDK close callbacks cannot restore an expired or released entry.

Normal process shutdown explicitly drains HTTP connections for at most five
seconds, concurrently with WebSocket shutdown. It rejects new connections and
GET/POST work, closes existing streams, and retains only already admitted
connection IDs and their original bindings and cleanup results. During this
explicit drain, authenticated same-binding DELETE requests may complete even
though process readiness is false. Ordinary not-ready operation has no such
exception. Workload/CCT admission, identity matching, full empty-body validation
and cleanup-before-202 remain mandatory; cleanup failures remain failures.
The drain does not extend an existing retirement deadline. After all entries
finish, or when the drain expires, forced shutdown aborts any remaining responses
and joins their cleanup before listener retirement. A held DELETE body or a
nonresponsive peer cannot renew the shutdown window.

## Connection quotas (#49)

ACP implements the [connection admission contract](connection-admission.md) with shared
HTTP/WebSocket limits for the process, the authenticated organization and its
principal. Quota identity comes only from the verified workload and signed
caller context; caller hints cannot select another quota bucket. The contract
preserves the HTTP cleanup ownership and response-join rules above. Existing
connection requests do not acquire additional reservations, and retained
cleanup remains counted until it actually finishes. HTTP and v1/v2 WebSocket
connections use the same process-local capacity owner, replacing the old
HTTP-only 1024-entry cap. Socket/SDK closure and connection-owned raw work must
settle before release; a cancelled wait or timed-out send is not cleanup proof.
Supervisor-owned Run completion is independent of connection lifetime. These
limits do not enable multiple replicas or establish cluster-wide quotas.

## Provider destinations (#28)

Actual model calls use the [shared destination policy](../platform/provider-destination-policy.md)
independently of private workload transports. All DNS answers are rechecked per
completion and sockets are pinned to approved literal IPs with original TLS/Host
identity. Redirects, environment proxies and private credentials are excluded.
Only exact operator configuration can opt into private endpoints; snapshots,
Templates and caller context cannot. Existing Run receipt classifications add
`provider_endpoint_forbidden` and `provider_endpoint_unavailable` within their
existing string contract; ACP messages and browser DTOs do not change.

## Runtime barrier control admission (#50)

The implemented `POST /rpc/agent-acp/get-runtime-barrier` query is defined by the
[pending recovery contract](execution-api.md#runtime-barrier-recovery-50-pending).
Its Controller consumer, UI recovery and cross-service integration admission
remain pending. The ACP caller catalog grants this route only to Controller.

This route belongs only to `ANTNEST_ACP_CONTROL_LISTEN` and
requires the verified `agent-controller` workload. The workspace listener must
return 404 before reading the body or authenticating, including method/query
variants. On the correct listener, missing or invalid workload credentials
return 401 `service_unauthenticated` with the token challenge; a verified wrong
workload returns 403 `caller_not_allowed`. No user CCT, user state route or
body-selected caller grants authority. This amendment grants no Gateway or
Agent UI access to the control query.

The request is one strict JSON object selecting exactly one organization,
Agent and expected Runtime revision. It follows the existing control JSON,
body-validation and workload rules. Only the scoped, non-secret recovery
receipt may be returned: never credentials, endpoints, Run/Tool identifiers or
their contents. Scope/revision failures and unavailable configuration/storage
remain errors under the execution API contract, not successful null receipts.
