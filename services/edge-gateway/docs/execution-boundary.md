# Browser Bridge Execution Boundary

Gateway 24 admits browser workspace traffic through Agent UI. Controller and
ACP are private downstream dependencies; Gateway has no direct browser ACP
relay, Controller discovery client or ACP state client.

## Ownership

Gateway authenticates the browser and derives Organization and principal from
Identity, with Agent scope selected by the actual Bridge route. It forwards
the unchanged signed CCT and verified presentation hints using Agent UI workload
authentication. Incoming cookies, browser bearer credentials, reserved headers
and trailers do not reach Agent UI. Neither labels nor an administrator flag
replace downstream resource authorization.

Agent UI owns browser DTOs and command/recovery semantics. Controller owns
management metadata; ACP owns Agent/Session access, private protocol behavior
and durable execution. An Agent appearing in discovery does not authorize a
Session operation. Their private v1/v2 ACP interfaces remain available for
authenticated service callers and protocol tests. Removing Gateway's direct
clients does not retire the receiver credentials by itself; Controller and ACP
each have a separate receiver-owned delivery batch.

Identity's workspace CCT audiences for Controller and ACP remain needed by
Agent UI's downstream calls. Do not remove those audiences, Agent UI workload
grants, URLs or networks when retiring Gateway's unused grants.

## HTTP and observer boundaries

Gateway preserves admitted Bridge methods, route/query and body, forwards the
route header allowlist, and independently injects verified scope. It does not
interpret protocol methods, retry prompts or invent execution availability.
Commands and prompts retain their body limit, timeout and ordinary HTTP drain.

Only Bridge events and administrator event watches are managed receive streams.
Their guards start before opening upstream and retain original session identity,
roles and absolute expiry. Every returned CCT and cache/feed proof must remain
valid. Quiet and blocked streams retain the 30-second source-age bound; fresh
idle eligibility may be observed only through legitimate live resolution.

Observer disconnect, session revocation and Gateway shutdown cancel and join
the upstream observer, not an accepted Run. Actual user cancellation must reach
the owning command/operation API. Admission overlapping revocation is not a
distributed transaction with later Run creation.

Route classification preserves escaped path segments; encoded separators
cannot escape shutdown tracking. Agent IDs retain header-safety and length
validation without inventing a Gateway-owned namespace grammar.

## Verification

Gateway tests cover real Identity/Bridge HTTP forwarding, forged headers,
Origin/CSRF, scope changes, upstream rejection, trace parenting and receive
lifecycle. They do not prove receiving-service CCT signature verification or
private ACP business semantics.

Those owning-service tests and explicit cross-service integration must retain
prompt, cancel, approval, Session load, state/events and reconnect without
replay. Capacity acceptance additionally proves actual cancellation of another
user's same held Runtime work within one second while a near-limit attachment
is being received and while EOF processing overlaps. See the
[shared retirement contract](../../../contracts/edge-gateway/workspace-entry-retirement.md).
