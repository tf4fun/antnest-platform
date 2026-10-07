# Runtime Controller Control API

Runtime Controller exposes a small JSON-over-HTTP RPC surface to Agent
Controller with verified workload identity on its purpose-specific private listener. Revision 16 includes private Runtime connection resolution; revision 15 requires the [exact workload profile](service-authentication.md), adds admission errors and operator image allowlists, and separates loopback readiness from the control surface. It performs no end-user authentication. The cross-service aggregate is one Runtime Environment per
Agent. Docker containers, Kubernetes Pods, workspace volumes, physical
generation numbers, deployment digests, and platform resource identifiers are
private implementation details.

The complete machine-readable route, header, status, error, and message
contract is `control-contract.json` plus `control-api.schema.json`.

All JSON decoders reject unknown fields. Agent and request identifiers use
1-200 deployment-safe ASCII bytes. Every mutation carries `Idempotency-Key`.
Reusing a key with identical input returns the original result; reuse with
different input returns `request_id_conflict`. W3C `traceparent` and optional
`tracestate` propagate across the boundary.

Legacy shared-volume Skill inventory, backup and migration-only active-set
verification are not part of this API. Their retired paths return 404 for all
methods. Normal Skill preparation and the Docker adapter's mount/manifest
verification continue to protect lifecycle operations.

## Runtime Revision

Runtime Controller returns an opaque `runtime_revision`. Callers store and
compare this value but never construct, increment, parse, or attach business
meaning to it. Update, Disable, Enable, and Delete carry the current revision as
`expected_revision`; a stale request returns `runtime_revision_conflict`.

An operation reports `target_revision`, which is fixed before execution and is
stable across retries. It becomes the Environment's current
`runtime_revision` only after that operation commits its lifecycle result.

Runtime Controller privately allocates a compute generation for Initialize,
Update, and Enable. That number is supplied to Antnest Runtime and platform
labels, but never appears in this API.

## Private Runtime connection

Revision 16 adds `POST /internal/runtimes/{agent_id}/connection` for Controller
workload admission only. The JSON request carries `runtime_revision` and
`expected_execution_id`, with no Idempotency-Key. It requires a provisioned
current Environment and a fresh authenticated full-status identity check under
the Agent lock. An absent instance returns 404, stale binding 409
`runtime_connection_stale`, and unavailable verification 503
`runtime_connection_unavailable`. Only the 503 failure is retryable.

The [shared schema](../../../contracts/runtime/instance-connection.schema.json)
defines the private response. It returns ACP's per-instance token alongside the
exact current binding; RC's status token is never exported. All responses use
`Cache-Control: no-store`; request and response content capture is unconditionally
disabled, including with RPC debug capture enabled. Ordinary Inspect/List,
operation receipts and observations contain no instance credential.

RC atomically persists the sealed two-caller record with compute admission.
RuntimeSpec contains only connection ID, fixed caller-file location and receiver
digest. A root-only receiver volume is read back, mounted read-only, and checked
again after actual container creation before start. Docker liveness uses
`/status/live`; RC identity checks always use authenticated full `/status`.
Consumer implementation and cross-service acceptance remain separate #30 batches.

## Lifecycle

The stable lifecycle is:

```text
uninitialized --Initialize--> provisioned
provisioned   --Update-----> provisioned
provisioned   --Disable----> disabled
disabled      --Enable-----> provisioned
provisioned   --Delete-----> deleted
disabled      --Delete-----> deleted
failed        --Delete-----> deleted
```

Transitions may report `initializing`, `updating`, `disabling`, `enabling`, or
`deleting`. An inconclusive platform effect reports `unknown` and retains the
Agent mutation slot. Until a mutation is terminal, the caller retains its
method, path, exact body, and `Idempotency-Key`; only that exact request may
reconcile it.

Initialize failure does not erase resource ownership. A definitive platform
failure retains a `failed` Environment with its target revision and private
deployment identity, even if only workspace creation completed. Confirmed
compute create/start completes the operation independently of application
readiness. The operation is terminal and releases its mutation slot. Exact retries return
that failed result; a new Initialize cannot overwrite the retained Environment.
The caller may Delete using its current revision. Delete checks and removes
owned compute if present, then removes owned workspace. A failed Environment
is not executable, `disabled`, or an absence proof. Actual unknown platform
effects keep their slot and continue to require exact-request reconciliation.

Consumers must not equate an unpublished executable Runtime revision with
absence of deployment resources. Agent Controller must resolve the owner
service's retained revision before deleting a failed Agent; the Agent Controller
failed-build cleanup does this before it deletes the Agent.

All mutations for one Agent are serialized across Controller replicas. The
PostgreSQL lock session is monitored while a mutation runs. A database
invariant permits only one `running` or `unknown` operation per Agent.

## Runtime Configuration

Optional `configuration.mcp_servers` configures required stdio MCP processes in
Runtime, using the [shared RuntimeSpec](../../../contracts/runtime/runtime-spec.schema.json)
shape: `[{"id":"docs","command":"node","args":["/workspace/mcp/docs.js"],"env":{}}]`.
Executables must already be present in the selected image or workspace. Omit
the array (or send `[]`) for no managed servers. Limits: eight unique server
IDs, 32 KiB per server and 64 KiB for the encoded array, 64 arguments and 64 env
entries per server. Runtime owns initialization, tool aggregation and process
lifetime; Controller never launches stdio programs itself. New configuration
requires Update or Enable, and participates in idempotency/deployment digests.
Operation/inspection/observation responses never contain this bootstrap data.
Readiness is not returned before the required servers initialize successfully.

Initialize, Update, and Enable carry a Runtime configuration:

```json
{
  "configuration": {
    "image_ref": "antnest/antnest-runtime@sha256:...",
    "network": {
      "packet_contract_revision": 1,
      "egress_endpoint": { "ipv4": "10.20.0.8", "port": 8092 },
      "tunnel_ipv4": "100.64.0.2",
      "resolver_ipv4": "100.64.0.1"
    },
    "resources": {
      "memory_bytes": 2147483648,
      "pids_limit": 512,
      "tmpfs_bytes": 536870912
    }
  }
}
```

For system Skills, the same configuration also carries `organization_id`,
the frozen `system_skills` array, `prepared_skill_set` (digest and layout
version), and `prepared_reference_id`. The four fields must appear together,
including an empty `system_skills` array. RC accepts only the exact ready,
unreleased reference for this Agent, then persists the selected private volume
in the lifecycle operation. An invalid reference returns non-retryable
`prepared_skill_set_invalidated` before lifecycle admission; temporary Docker
inspection failure returns retryable `skill_preflight_unavailable`. The preparation
endpoint returns retryable `skill_cleanup_in_progress` while an old physical
set is being removed and non-retryable `skill_preparation_closed` after Delete
has begun. Refer to the [delivery contract](../../../contracts/skill-registry/runtime-delivery-api.md)
for the complete preparation and recovery flow.

The Controller injects Agent identity, internal generation, Runtime listener,
workspace and system-Skill paths, platform networking, mounts, healthcheck,
restart policy, and Runtime telemetry. Callers do not duplicate those adapter
or Runtime-image invariants.

## Image Resolution

`GET /internal/runtime-images/resolve?reference=antnest/antnest-runtime:local`

This read-only query resolves an image name, tag, image ID or repository digest
already installed on the deployment platform. It returns `reference` (the
submitted reference) and `image_ref` (the immutable Docker image ID).
It creates no Runtime, operation, lock, database record, or image pull. Missing
images return `404 image_not_found`; the operator must build or load them first.
Invalid references return `400 invalid_request`, platform failure
returns `503 platform_unavailable`, and a deadline returns `504 deadline_exceeded`.
The query takes no `Idempotency-Key` and is not required when saving a Template.

The Docker adapter uses image inspection, not registry metadata. Its image ID
is a Docker content identity, not a repository manifest digest, and must never
be appended to a repository name to fabricate `repository@digest`. Local builds
without `RepoDigests` are valid. The response contains no image environment,
build history, labels, platform paths, or registry credentials. Resolution
proves the current local image identity, not Runtime MCP compatibility or future
availability after an operator removes the image. Lifecycle configuration accepts
names/tags and immutable references, preserving the submitted `image_ref` through
Initialize, Update and Enable. Each new build persists the original reference and
resolved image ID before platform mutations. Docker creation and same-operation
recovery use that ID. Operation queries return optional `image_reference` and
`image_id` for audit, including after container deletion. Missing legacy metadata
means unknown, not an inferred image. The resolved ID never replaces the configured
input to a later rebuild. The same Template
using a moved tag can therefore build different images. Local image installation
and remote pull policy are separate concerns; no automatic pull or running
container update is introduced. Runtime readiness belongs to independent observation and explicit reads,
not lifecycle command completion. HTTP and platform-operation spans use the normal request trace; image
references are not metric labels or recorded request bodies.

Docker reference parsing uses the standard
[`distribution/reference`](https://github.com/distribution/reference) library.
Inspection follows the
[Docker Engine image API](https://docs.docker.com/reference/api/engine/version/v1.47/).

## Initialize

`POST /internal/runtimes/{agent_id}/initialize`

Initialize requires no existing Runtime Environment. It:

1. creates or adopts the owned Agent workspace;
2. allocates the first private compute generation;
3. creates and starts the compute resource;
4. commits `completed` with lifecycle state `provisioned` and releases the mutation slot;
5. returns the target revision and image metadata, without asserting health or execution identity.

See [creation and observation](../docs/creation-and-observation.md). Current
health, MCP endpoint and verified execution ID are obtained through Inspect/List
and the independent observation flow. Startup failure never rewrites a completed
creation command.

A workspace created before compute failure is retained. Retrying the same
nonterminal request reconciles it; a terminal failed request replays its result
without further effects. Delete the failed Environment's retained revision
before recreating the Agent. Runtime Controller never rolls back durable data.
Initializing an existing or deleted Agent identity returns
`runtime_lifecycle_conflict`.

## Update

`POST /internal/runtimes/{agent_id}/update`

The request carries `expected_revision` and a complete new configuration.
Update is valid from `provisioned`, including starting or unhealthy resources.
It removes the current compute resource, retains the workspace, allocates a new
private generation, creates/starts the replacement and returns a new revision. Agent Controller blocks new
Runs around this command.

If platform create/start effects cannot be confirmed after removing the old
compute, the operation is `unknown` and the same request must be reconciled.
Application readiness has no effect on that command result. Runtime Controller does not perform implicit
rollback.

Retrying an interrupted Update reconciles its original target, including when
the replacement already exists but the platform/completion response was lost. It does not delete a new target using the old source identity, allocate
another generation, or restore the destroyed source. Foreign identity and
unavailable platform observations remain nonterminal; only an exact existing
target can be adopted after platform identity and retained storage checks. These
are corrections to the existing retry contract, not additional caller fields.

## Disable

`POST /internal/runtimes/{agent_id}/disable`

Disable is valid from `provisioned`, regardless of current health. It removes the compute resource and retains
the workspace. Success returns lifecycle state `disabled` and a new revision.
The service does not retain a stopped Docker container because that would not
have a portable Kubernetes equivalent and would not release compute resources.

## Enable

`POST /internal/runtimes/{agent_id}/enable`

Enable is valid only from `disabled`. It carries `expected_revision` plus the
latest complete Runtime configuration, allocates a new private generation, and
creates compute over the retained workspace. Configuration changes made while
the Agent was disabled therefore require no Runtime Controller desired-state
storage.

## Delete

`POST /internal/runtimes/{agent_id}/delete`

Delete is valid from `provisioned`, `disabled`, or `failed`. It removes compute when present,
then removes the owned workspace and records the Agent identity as `deleted`.
Deleted Agent identifiers cannot be initialized again. Partial deletion is
reconciled with the same request ID.

## Inspect And List

Revision 18 exposes `runtime_endpoint` when a Runtime has a usable Docker IPv4
on the configured management network. RC inspects that exact network attachment;
hostnames and the MCP URL are not used to infer it. Controller reads this current
inspection after completed Initialize, Update or Enable and before opening
Egress. A failed address inspection prevents opening traffic and can be retried;
it does not change an already-completed compute receipt. This field is network
identity metadata, not an execution ID or a proof of Runtime health. Current
Inspect/List report a changed address after restart; absent compute has no address.

A running container with a missing or invalid management IPv4 is reported as
an individual inspection with `phase: running`, `health: unknown`, reason
`runtime_peer_unavailable`, and no `runtime_endpoint`. No execution identity is
verified for that inspection. It cannot be used to open an Egress attachment,
but it does not fail the inventory or hide unrelated healthy Runtimes.
A restarting container is not running: it keeps `phase: created` with reason
`runtime_restarting` and has no `runtime_endpoint`, even when Docker still
reports it as running.

`GET /internal/runtimes/{agent_id}` returns the logical lifecycle state and
opaque revision. When state is `provisioned`, it reads current platform state
and performs one bounded Runtime status check for a platform-healthy process.
Unverified status returns unknown health without inventing an execution ID. The response may contain MCP
endpoint, execution ID, health, restart count, and observation time. It never
contains physical generation, digest, container/Pod ID, volume ID, or raw
platform status.

`GET /internal/runtimes` returns all non-deleted Runtime Environments. Deleted
identities remain private tombstones and can still be inspected directly by
Agent ID. The list is the authoritative recovery companion to a service-wide
observation gap. Every
`provisioned` Environment is checked against the private platform identity; drift
fails the request instead of being silently omitted.

## Operations

`GET /internal/runtime-operations/{request_id}` returns the immutable request
identity, operation kind, current state, effect state, target Runtime revision,
logical Runtime inspection, and sanitized failure. A process crash
may leave `running`; retrying the original mutation with the same request ID
reconciles platform resources. `unknown` never means absent or safe to replay
under a new request ID.

## Observations

`GET /internal/runtime-observations?after_sequence={n}&limit={n}` returns an
ordered page from the bounded Controller journal. The response carries
`oldest_sequence`, `latest_sequence`, and `next_sequence`. Sequence zero is the
bootstrap cursor and always starts at the oldest retained observation.

If a non-zero cursor is older than the retained window, List and Watch return
HTTP 410 `observation_cursor_expired` with `reset_sequence` set to the latest
committed sequence visible to that read. The consumer must rebuild its logical
projection with `GET /internal/runtimes`, then resume Watch from
`reset_sequence`. Consumer-history expiry is deliberately distinct from a
platform `observation_gap`.

`GET /internal/runtime-observations/watch?after_sequence={n}` returns
`text/event-stream`. Watch is only a low-latency wake-up path: clients first
read List, consume Watch, and return to List after disconnect. Delivery is at
least once, so callers de-duplicate by sequence.

Observations use three disjoint shapes. `observation_gap` and `reconciled` are
service facts without Agent identity. Lifecycle and workspace facts are
Environment facts carrying Agent ID plus opaque revision. Platform process
facts are Runtime-generation facts projected as Agent ID, revision, event kind,
execution ID when known, diagnostic summary, and time; generation, digest, and
platform resource ID remain private. `runtime_missing` means a logical provisioned
Environment had no matching resource in the inventory and a subsequent exact-key
platform inspection confirmed absence. Agent Controller decides each fact's
business meaning. Logical Inspect/List return that provisioned Environment with
`health=absent`, an empty MCP endpoint and empty execution ID. An inspection
failure or identity conflict is an error, never proof of deletion.

## Status

`GET /status` reports local initialization, own-storage and background monitor
readiness. Control contract revision 14 adds the required `monitor_ready`
boolean on both HTTP 200 and HTTP 503 responses:

```json
{
  "status": "ready",
  "live": true,
  "ready": true,
  "database_ready": true,
  "platform_ready": true,
  "observation_ready": true,
  "monitor_ready": true
}
```

`ready` requires all four component flags. `platform_ready` denotes local
adapter initialization; `observation_ready` denotes journal and notification
readiness. `monitor_ready` reads only the in-process flag maintained by the
background monitor, without calling Docker or scanning Runtimes. Leaders set
it after reconciliation and the Watch handshake; followers mirror the shared
Watch-ready lease on their normal one-second poll.

Monitor retries and Watch reconnection report HTTP 503 while the process
continues running. For a monitor-only outage:

```json
{
  "status": "not_ready",
  "live": true,
  "ready": false,
  "database_ready": true,
  "platform_ready": true,
  "observation_ready": true,
  "monitor_ready": false
}
```

One unhealthy Runtime does not make the Controller unready. A Watch-only
disconnect can make Controller readiness false while lifecycle calls still
succeed through a reachable Docker API. Docker API unavailability also causes
actual platform-dependent calls to fail. See
[operations](../docs/operations.md#observation-dependency-recovery) for startup
and probe thresholds. The Controller's own `--healthcheck` consumes only the
HTTP status code.

## Failure Semantics

| Condition                                                | Result                | Caller behavior                                           |
| -------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| Invalid command or lifecycle transition                  | failed / not_started  | Correct request                                           |
| Stale expected revision                                  | failed / not_started  | Reload Runtime and decide again                           |
| Definite platform rejection before mutation              | failed / not_started  | Correct input or platform state                           |
| Lost response after possible mutation                    | unknown / unknown     | Retry the same request ID                                 |
| Platform effect cannot be determined                     | unknown / unknown     | Inspect and retry the same request ID                     |
| Runtime starting/unhealthy after successful create/start | completed / completed | Observe current state; do not retry the completed command |
| Confirmed complete deletion                              | completed / completed | Agent deletion may finish                                 |

Historical operations recorded before creation/readiness separation retain
their original `runtime_not_ready` diagnosis when queried or replayed. New
creation commands never emit this error.

`not_started` describes the rejected platform substep, not an assertion that
Initialize allocated nothing. Its workspace may already exist; retained
Environment ownership and an explicit Delete, not that effect flag, govern cleanup.

Errors use one stable JSON shape and never expose SQL, Docker socket paths,
credentials, environment values, Runtime output, or physical resource names:

```json
{
  "code": "runtime_revision_conflict",
  "message": "Runtime revision is stale",
  "retryable": false
}
```

## Managed MCP secret bootstrap

`mcp_servers[].secret_env` accepts only frozen set/fingerprint descriptors.
When any are present, `managed_mcp_template` pins organization_id, template_id
and revision; inline values and keep actions are rejected at this boundary.
These descriptors and source are frozen in the deployment digest and journal.
RC resolves values only through its authenticated Controller bootstrap client.
Controller verifies AEAD and the opaque HMAC fingerprint; RC checks exact names
and resolved size/encoding bounds, without deriving or exposing the HMAC key.
`ANTNEST_AGENT_CONTROLLER_URL` must be configured for such deployments; RC's
service-token directory must include the Controller token.

RC prepares a generation-private root-only bootstrap volume, then verifies the
actual read-only/nocopy mount, labels, file ownership, permissions and contents
after container creation and before start. A Docker-created unlabeled empty
replacement is refused. Replay rechecks the actual mount. Disable, replacement
and Delete remove the owned generation's private volume; Enable resolves the
Agent's retained frozen source. No value enters RuntimeSpec, Docker environment,
labels or deployment digests. MCP cache HOME/TMPDIR/XDG directories use a separate root-owned
0711 exec/nosuid/nodev tmpfs at `/run/antnest-mcp-home`, bounded by
`resources.tmpfs_bytes` across all servers. Runtime creates UID-owned 0700
children. This cache resets on container restart. The bootstrap volume survives ordinary container
restarts; it is excluded from workspace backup and rebuilt from Controller on
restore. See the [shared contract](../../../contracts/runtime/managed-mcp-secrets.md).

`resources.tmpfs_bytes` is the size limit of each mount, not a single combined
budget for `/tmp` and MCP HOME. All MCP servers share the HOME mount without
per-server quotas; one server filling it can prevent others from writing caches.
The mounts grow on demand and their actual usage shares the existing
`resources.memory_bytes` limit with all Runtime processes. Configuring two equal
mount limits neither reserves twice that RAM nor increases the container memory
limit; insufficient memory can trigger OOM before the filesystem size limits.
