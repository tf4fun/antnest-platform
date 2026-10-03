# Platform trust model

The [service authentication contract](../../contracts/platform/service-authentication.md)
answers two separate questions for each internal request: which workload is
calling, and which authenticated user or already accepted operation it serves.
Service URI identities, per-route caller lists and Identity-signed CCTs replace
the design assumption that a reachable internal peer is trusted.

## Current delivery status

The foundation defines schemas, public verification fixtures, planned caller
catalogs and a repository route-coverage check. It does not install authentication
middleware. The [rollout ledger](../../contracts/platform/service-authentication-rollout.json)
records the pending service/deployment/integration batches. Existing trusted
headers, body actors, shared Registry tokens, wildcard listeners and published
internal ports remain release blockers under
[#80](https://github.com/tf4fun/antnest-platform/issues/80).

## Request boundaries

Browsers and external channels enter through Gateway. Gateway authenticates a
session and requests an Identity CCT for a server-selected consumer profile and,
when applicable, a specific Agent. BFFs forward the signed context unchanged;
each receiver authenticates its immediate workload peer and verifies the CCT's
audience, lifetime and target scope before existing business authorization.
`X-Antnest-*` and body actors are not substitute credentials in the target model.

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

The deployment batch moves diagnostic host ports into an explicit debug overlay,
keeps Gateway as the sole base published port and provides an explicit outbound
path for model inference. The [security policy](../../SECURITY.md) continues to
describe current limitations until the service and Docker security E2E batches
prove the new boundary end to end.
