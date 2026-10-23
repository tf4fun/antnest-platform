# Runtime Controller workload boundary

Control revision 20 uses the existing
[platform authentication contract](../../../contracts/platform/service-authentication.md).
Lifecycle, Runtime inspection, image, observation/SSE, private Runtime connection
and Skill preparation routes require the verified `agent-controller` workload.
Only `POST /internal/acp-incarnations/register` and
`GET /internal/acp-incarnations/{registration_id}` require the verified
`agent-acp-service` workload, without CCT. Neither caller gains the other's
routes. RC is not its own API caller.
Missing, duplicate or malformed credentials return `401 service_unauthenticated`
with the dedicated challenge; a known different workload gets
`403 caller_not_allowed`. These checks precede request decoding, journal writes
and Docker effects. Lifecycle routes consume Controller-owned accepted
operations; incarnation routes consume only the closed registration/inspection
wire. Unsigned user/Organization/CCT hints do not authorize either surface and
are stripped.

JSON mutations require exactly one `application/json`, optionally with UTF-8
charset. Ambiguous/missing media or unsupported content encoding gets 415.
The existing lifecycle/Skill 1 MiB limit remains. Incarnation registration has a
4 KiB body limit, inspection has no body or query, and both replies are capped
at 8 KiB. Invalid UTF-8, BOM, duplicate decoded members, case aliases, extra
documents and unknown DTO fields get 400 before effects.

Startup requires exact token/mTLS configuration. There is no default credential
or fallback. Token receivers load a bounded per-caller SHA256 file at startup;
senders read each receiver token file for every request. Registry downloads use
the dedicated service header, pinned private origin, trusted TLS identity,
disabled redirects and no environment proxy. The old
`ANTNEST_SKILL_REGISTRY_API_TOKEN` setting is retired; a nonempty value fails
startup. Sender credentials remain outside lifecycle request bodies and receipts.

## ACP incarnation authentication

The two incarnation routes use the exact grants in `callers.json`, not a global
expansion of the Controller-only boundary. Configure the inbound ACP receiver
credential as well as RC's existing outbound sender credential for receiver
`agent-acp-service`. The private probe sends workload authentication only; it
does not forward CCT, cookies, browser authority or user/organization hints.
It retains the configured logical origin while dialing the exact literal IP
from Docker Inspect on the member's configured network. There is no proxy,
redirect or DNS fallback and no caller-selected destination.

Each RC operation has a ten-second total bound, shortened by its caller's
earlier bound. Work reserves at most 100ms within it for response and actual
cleanup; the private probe has its own two-second maximum within the remaining
registration budget. Registration uses the original member/incarnation/nonce
tuple for exact retries, not an `Idempotency-Key`. All replies are `no-store` and
request, response and error payload capture is always disabled. Nonces,
credentials, Docker identity and configured addresses never enter public
projections or diagnostic payloads.

The operator's optional `ANTNEST_RUNTIME_ACP_MEMBERS_FILE` is a startup snapshot,
limited to 64 KiB and 128 members; its closed version-1 format is documented in
[operations](../docs/operations.md#acp-incarnation-members). Its selectors and
member networks remain private and independent of Runtime management-network
selection. This reuses RC's current authentication, PostgreSQL migration 14,
Docker observer and probe client; it adds no service, image or authentication
profile.

## Listener ownership

`ANTNEST_RUNTIME_CONTROLLER_LISTEN` requires an explicit unicast IP and nonzero
port; default `127.0.0.1:8080` is local only. Production deployment binds it to
the `controller-runtime` address. Wildcards, hostnames and multicast are rejected.
The outbound Runtime-management attachment does not expose a control listener.

`ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN` is a separate loopback-only address,
default `127.0.0.1:8082`. It exposes only GET/HEAD `/status`, preserving revision
14's required `monitor_ready` and readiness semantics. Remote readiness requests
are not admitted. `--healthcheck` reads the configured local health port with
trusted TLS/mTLS when enabled, and needs no application token/CCT/database input.
The purpose-network deployment and default host-port removal belong to the later
deployment batch; attaching multiple networks alone is not listener isolation.

## Runtime image policy

`ANTNEST_RUNTIME_ALLOWED_IMAGES` is an operator-owned JSON array of repository
names or exact `repository@sha256:<digest>` manifests. Unset, empty string or `[]`
defaults to the normalized `docker.io/antnest/antnest-runtime` repository.
Repository entries permit its tags/digests. Manifest entries permit only that
digest, never an arbitrary tag. Tagged allowlist entries, glob patterns, malformed
digests and duplicate normalized identities fail startup. Request references
cannot combine a tag and digest or use unnamed image IDs to bypass repository
authorization. Registry host, port and repository are compared in full, without
substring/prefix matches.

Resolve, Initialize, Update and Enable reject a disallowed selection with
`422 image_not_allowed` before querying Docker or accepting a new operation.
An allowed installed reference resolves to its immutable image ID; container
creation uses that ID even if a tag moves. RC never pulls a missing image. An
already accepted operation retains its frozen image identity for exact replay.
Changing the operator allowlist controls future admission, rather than rewriting
accepted journal records. Skill preparation helper images are separate trusted
operator configuration and cannot be selected in a lifecycle request.

## Docker socket assessment

RC still holds the local Docker socket and therefore host-equivalent authority.
Service authentication and image policy reduce remote admission risk; they do not
contain a compromised RC process. Do not expose the daemon or RC credential to
Runtime/executor/user workloads. Raw socket compromise is documented in
[SECURITY.md](../../../SECURITY.md).

A generic method/path socket proxy is insufficient: RC needs Ping/version,
image inspect, filtered container list/inspect/events, create/start/stop/delete,
volume inspect/create/delete and network inspect. Legitimate lifecycle creation
also needs bounded archive writes for prepared Skill volumes. A useful future
proxy must enforce RC scope/managed labels on each resource, validate create
payloads and image identities, retain only exact needed methods, and check archive
targets. Allowing every container/volume endpoint would merely relocate daemon
authority. Implementing that resource-aware proxy is a separate platform batch;
Runtime capability/seccomp hardening remains #35. This batch does not claim a
Docker sandbox against the host administrator or Docker-daemon compromise.

## Admission order

RC unit/contract/component, isolated PostgreSQL and applicable owning-service
Docker gates remain required; production wiring is not a claim that those gates
or remote CI have passed. The incarnation registration/inspection producer is
wired here. ACP's private probe implementation and registration consumer, lease
coordinator, fenced writers, scoped recovery, configuration/revocation ACKs,
peers, deployment and explicit two-replica integration remain pending. The ACP
global worker lock remains until those batches pass. This producer does not
enable multiple active ACP replicas. Existing execution fences, maintenance
tickets and #50 protections for unknown Runtime effects remain independent.
