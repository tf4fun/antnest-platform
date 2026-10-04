# Platform trust model

The [service authentication contract](../../contracts/platform/service-authentication.md)
answers two separate questions for each internal request: which workload is
calling, and which authenticated user or already accepted operation it serves.
Service URI identities, per-route caller lists and Identity-signed CCTs replace
the design assumption that a reachable internal peer is trusted.

## Current delivery status

The foundation defines schemas, public verification fixtures, caller catalogs
and a repository route-coverage check. All ten owning-service authentication
batches have passed their local gates. Compose now wires private per-pair keys,
purpose listeners, isolated private bridges and bounded diagnostic/OTLP transports.
Actual deployment and cross-service security/business acceptance have passed
for the disposable token/HTTP profile: 24 networks, 560 network checks and 30
genuine issuer/context/role/Runtime checks, followed by browser, lifecycle and
Skill workflows. The [rollout ledger](../../contracts/platform/service-authentication-rollout.json)
records local, deployment and integration evidence separately under
[#80](https://github.com/tf4fun/antnest-platform/issues/80).

## Request boundaries

Browsers and external channels enter through Gateway. Gateway authenticates a
session and requests an Identity CCT for a server-selected consumer profile and,
when applicable, a specific Agent. BFFs forward the signed context unchanged;
each receiver authenticates its immediate workload peer and verifies the CCT's
audience, lifetime and target scope before existing business authorization.
`X-Antnest-*` and body actors are not substitute credentials.

Controller-owned lifecycle actions and ACP-owned accepted Runs use their owned
operation/snapshot context on separately allowlisted routes. They do not retain
an expired user CCT as a background credential. Automatic Skill learning keeps
its signed maintenance tickets and execution fences. Runtime workload identity
does not grant control-plane authority or bypass these proofs.

Health and protocol exceptions are explicit in each caller catalog. OIDC state,
SCIM bearer authorization, browser session rules and multipart/archive content
rules stay with their protocol owners. Administrative Identity RPCs derive the
actor from the CCT and verify the body echo; a service credential alone cannot
impersonate a named administrator.

## Deployment boundaries

Network segmentation reduces exposure and follows actual caller relationships,
but cannot authenticate a request. Multi-homed wildcard listeners must be split
or bound to the intended interface. Runtime management carries outbound control
to Runtimes, never incoming administration from Runtimes. The Docker socket is
host-root authority; RC's authenticated control API and image policy remain
essential even on an internal network.

The deployment batch moves diagnostic host ports into an explicit relay overlay,
keeps Gateway as the sole base published port and provides an explicit outbound
path for model inference. The [security policy](../../SECURITY.md) continues to
describe the remaining privileged-host and production-transport limitations.
`make e2e-service-authentication-integration` admits the full development token
profile; a full-platform mTLS deployment and the independent #35, #58 and #77
work remain outside this admission.
