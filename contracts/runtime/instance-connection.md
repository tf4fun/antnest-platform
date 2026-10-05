# Runtime instance connection contract v1

This contract freezes the #30 private connection handoff before its owning
service batches. The [machine contract](instance-connection-contract.json),
[schema](instance-connection.schema.json) and
[fixtures](instance-connection-fixtures.json) are normative alongside the
[exact workload profile](../platform/service-authentication.md). Service
implementations are delivered as owning-service batches: RC's issuer/volume/client,
native Runtime's receiver, Controller relay and ACP consumers are implemented and
have passed their owning-service gates. Coordinated deployment and native Runtime
MCP, learning, temporary-use and rebuild integration are admitted for the
token/HTTP profile in the
[rollout ledger](../platform/service-authentication-rollout.json).

## Ownership and credential identity

The selected approach is per-instance service tokens, not the alternative
short-lived ACP JWS in #30. RC issues separate CSPRNG 32-byte canonical base64url
tokens for `runtime-controller` and `agent-acp-service` for each
`(controller scope, Agent, private compute generation, caller)`. Tokens are
different across callers and instances. The execution ID is still a fence and
never becomes a secret.

RC is the issuer because it exclusively allocates and persists physical
generations; Controller sees opaque Runtime revisions. This refines #30's
Controller-issuer recommendation without exposing generation in a caller
deployment request. Controller authorizes business transitions and privately
relays the ACP connection; it does not allocate another credential lifecycle.

Issue the opaque `rci_<32 lowercase hex>` connection ID once with the generation.
The credential record and the accepted operation/generation claim commit in one
RC-owned transaction. Fresh nonce/AES-256-GCM sealed credential bytes are bound by
AAD to scope, Agent, generation and caller. The persistent RC master key is a
private operator file, separate from service bearer files and Controller's key.
No plaintext token enters the journal, Environment configuration or operation
receipt. A crash before admission cannot leave an independently accepted
credential; replay never generates replacement bytes.

Initialize, Update and Enable create fresh generations and credentials. Process
restart and exact recovery retain the generation's credentials and connection
ID. Disable/Delete remove the receiver bootstrap volume after compute absence
is conclusive; an unknown physical effect retains the original credential
record and reference until reconciliation finishes. Failed builds retain
ownership for the existing explicit Delete/recovery rules. No new user-visible
rotation or rollback feature is introduced.

## Root-only receiver bootstrap

RC materializes the platform caller-hash profile at
`/run/antnest-auth/callers.json` in a generation-specific read-only named volume.
The Runtime receives SHA256 hashes, never either raw bearer. The volume is
owned/labeled by scope, Agent, generation and connection ID; its root directory
is UID 0 mode 0700 and the regular file UID 0 mode 0600. Symlinks, other owners,
permissive modes, missing/oversized files and malformed/duplicate caller
configuration fail Runtime startup before opening HTTP.

A named volume is intentional: hashes are not raw credentials and it permits
verified preparation before container start. It is not a workspace or Skill
volume. RC verifies ownership and reads the complete expected file back, then
verifies the actual mount after container creation and before start. An
unexpected Docker-created empty volume is an error, never an empty-authority
fallback. Raw bearer material is not written into Runtime environment,
RuntimeSpec, container create payloads or executor inputs.

RuntimeSpec's bootstrap descriptor carries only the connection ID, fixed private
file location and complete receiver digest. Production `serve` requires it.
The exact service auth mode and transport opt-in
retain #101 semantics. HTTP requires explicit
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true`; absence is false. Unsupported
TLS/mTLS capability fails startup and must be documented by the Runtime batch.
There is no silent downgrade from mTLS to token or from HTTPS to HTTP.

## Private resolve and Controller relay

RC revision 16 adds:

```text
POST /internal/runtimes/{agent_id}/connection
Antnest-Service-Authorization: Bearer <Controller's receiver-specific token>
Content-Type: application/json

{"runtime_revision":"rtv_...","expected_execution_id":"execution-..."}
```

Only the Controller workload is allowed. This is a bounded read, not a lifecycle
mutation, and has no Idempotency-Key or invented end-user actor. RC requires a
provisioned current Environment and an exact revision/execution binding; an
absent instance is 404, stale binding 409 and unavailable verification 503.
Errors use static nonsecret messages. The return value is the schema's
`private_connection`: Agent, revision, execution ID, connection ID, exact MCP
endpoint and ACP's token. RC's own status token never leaves RC.

The endpoint sends `Cache-Control: no-store`. Request/response content capture is
disabled even when RPC debug capture is enabled; only bounded route, status and
logical identities may enter telemetry. Normal Inspect/List, observation,
operation receipts and Console projections never gain a credential field.

For each Agent accepting new Runs, Controller resolves the connection from its
persisted binding while building the authenticated private execution publication.
The resolve response is at most 8192 bytes of strict, unique UTF-8 JSON.
It compares every returned
identity/endpoint to that binding before relaying it. A mismatch closes
publication/admission; it cannot be repaired by a user-supplied endpoint or
token. Controller needs no second token database: after restart it re-resolves
from the owning RC. The relay stays on Controller -> ACP's dedicated control
listener and is excluded from telemetry content capture.

The [execution snapshot schema](../agent-acp/execution-snapshot.schema.json) and
[shared publication fixtures](../agent-acp/runtime-publication-fixtures.json)
distinguish executable references from closure. An accepting Agent's `runtime`
contains the four public reference fields plus `credential`. A closed Agent must
not transfer a credential and Controller does not resolve its Runtime: revocation,
Drain and settlement must remain publishable while RC/Runtime is unhealthy or
has already removed compute. Its retained revision/execution/endpoint is only
a fence for existing operations, with an optional already-known connection ID;
it does not establish a usable connection or bypass current admission.

ACP retains previously installed authority only for already accepted operations
under their original binding and normal stopping/settlement rules. The closed
publication cannot manufacture or rehydrate authority after ACP restart, clear
protection, or silently retarget a Run. An unavailable cleanup connection retains
the existing barrier outcome. On re-opening, Controller must resolve the current
verified private connection again. These closed semantics are deliberate
lifecycle behavior, not an anonymous fallback for executable Agents.

ACP separates the private credential from the public configuration before
persistence, audit or Run snapshot construction. The public reference contains
only the existing Runtime revision/execution/endpoint plus `connection_id`.
The private token is installed in ACP's own volatile, mode-0700 instance
directory as a mode-0600 `antnest-runtime` file. RC installs its own sender file
in its private volatile directory. Each request reads the trusted instance's
file; no process-wide Runtime token, cached fallback, shared browser mount or
user-controlled filename is allowed. A same-ID/same-binding publication cannot
replace token bytes. ACP restart requires fresh authenticated publication before
Runtime calls; public persisted metadata alone cannot reconstruct authority.

## Runtime admission, status and Host

All methods beneath `/mcp` authenticate before SDK dispatch. ACP alone may call
MCP, maintenance and temporary routes; RC and ACP may read full `/status`.
Unknown/missing/malformed/duplicate bearer returns
`401 runtime_unauthorized` with `Bearer realm="antnest-service"`, overriding the
generic receiver error name only for this Runtime wire profile. A known wrong
workload gets `403 caller_not_allowed`. Both are nonretryable. Token grammar,
canonical decode/re-encode, bounded UTF-8/JSON and constant-time SHA256 comparison
are otherwise exactly #101. No raw user/CCT header creates Runtime authority.

The execution fence remains required after credential verification. Signed
maintenance and temporary tickets remain separate authorization requirements.
A valid bearer never bypasses their Actor/Agent/generation/execution checks or
the single Runtime execution slot.

`GET/HEAD /status/live` exposes only `{"status":"ready"|"unavailable"}`, using 200
or 503. It never exposes Agent, generation, execution ID, connection ID, tool
catalog or verifier metadata. Docker liveness uses this route; RC's identity
verification still uses authenticated full `/status`, since liveness cannot
prove identity. No caller trusts the public liveness result as a binding.

Remove the SDK's `disable_allowed_hosts()`. Admit only the Runtime's own
server-owned management alias/address and loopback hosts with the configured
port, never a wildcard Host or a host named by a request. If RC publishes the
management alias rather than the current IP, it must be the exact owned
container alias and remain bound to the same connection. Runtime private
clients pin that origin, strip unrelated service/user/CCT authority, disable
environment proxies and redirects, and never derive a credential from a tool URL.

## Delivery and evidence

| Batch owner        | Work                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Runtime Controller | Atomic sealed instance credentials, verified receiver volume, private resolve, authenticated full-status client, live health |
| Antnest Runtime    | Root file/profile checks, whole-mount authentication, reduced liveness, Host restrictions, retained fences/tickets           |
| Agent Controller   | Resolve and validate the current private reference, relay only to ACP; safe projections and telemetry                        |
| Agent ACP Service  | Volatile instance sender files, private/public split, all MCP/status/maintenance/temporary consumers                         |
| Integration        | Purpose-network deployment/telemetry collector and complete chat/lifecycle/security E2E                                      |

Each owning batch has its own unit/contract/component and applicable isolated
Docker gate before its commit. Pending producer/consumer work remains recorded
until complete. Cross-service tests run only in the final integration batch on
`feat/service-authentication`.

The acceptance matrix includes wrong/missing/old-generation credentials,
per-caller restrictions, root-only/executor-inaccessible bootstrap, immutable
retry and process restart, new-generation rotation, unknown-effect recovery,
mount loss/readback, private-public projection and capture checks, all native
client paths without redirects/proxies, and hostile Host headers. Integration
must also prove that a peer on runtime-management cannot list/call tools and
that Jaeger is absent from that network. A dedicated runtime-telemetry collector
has no business/control API; normal stage-2/stage-3 chat and prepared Skills must
pass after all service batches.
