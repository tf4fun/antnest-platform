# Runtime Controller Control API

Runtime Controller exposes a small JSON-over-HTTP RPC surface to Agent
Controller on a trusted internal network. It performs no end-user
authentication. The cross-service aggregate is one Runtime Environment per
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

## Lifecycle

The stable lifecycle is:

```text
uninitialized --Initialize--> ready
ready         --Update-----> ready
ready         --Disable----> disabled
disabled      --Enable-----> ready
ready         --Delete-----> deleted
disabled      --Delete-----> deleted
```

Transitions may report `initializing`, `updating`, `disabling`, `enabling`, or
`deleting`. An inconclusive platform effect reports `unknown` and retains the
Agent mutation slot. Until a mutation is terminal, the caller retains its
method, path, exact body, and `Idempotency-Key`; only that exact request may
reconcile it.

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
      "egress_endpoint": {"ipv4": "10.20.0.8", "port": 8092},
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

The Controller injects Agent identity, internal generation, Runtime listener,
workspace and system-Skill paths, platform networking, mounts, healthcheck,
restart policy, and Runtime telemetry. Callers do not duplicate those adapter
or Runtime-image invariants.

## Image Resolution

`GET /internal/runtime-images/resolve?reference=antnest/antnest-runtime:local`

This read-only query resolves an explicitly tagged repository reference that is
already installed on the deployment platform. It returns `reference` (normalized
human-readable repository/tag) and `image_ref` (the immutable execution identity).
It creates no Runtime, operation, lock, database record, or image pull. Missing
images return `404 image_not_found`; the operator must build or load them first.
Invalid or untagged references return `400 invalid_request`, platform failure
returns `503 platform_unavailable`, and a deadline returns `504 deadline_exceeded`.
The query takes no `Idempotency-Key`: pinning and replay of a published Template
remain the responsibility of Agent Controller's Catalog transaction.

The Docker adapter uses image inspection, not registry metadata. Its image ID
is a Docker content identity, not a repository manifest digest, and must never
be appended to a repository name to fabricate `repository@digest`. Local builds
without `RepoDigests` are valid. The response contains no image environment,
build history, labels, platform paths, or registry credentials. Resolution
proves the current local image identity, not Runtime MCP compatibility or future
availability after an operator removes the image. Lifecycle configuration still
requires the immutable `image_ref` and retains the existing Runtime readiness
checks. HTTP and platform-operation spans use the normal request trace; image
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
3. creates the compute resource;
4. waits for platform health and matching Runtime `/status`;
5. returns `ready`, an opaque revision, MCP endpoint, and execution ID.

A workspace created before compute failure is retained. Retrying the same
request converges it; Runtime Controller never rolls back durable Agent data.
Initializing an existing or deleted Agent identity returns
`runtime_lifecycle_conflict`.

## Update

`POST /internal/runtimes/{agent_id}/update`

The request carries `expected_revision` and a complete new configuration.
Update is valid only from `ready`. It removes the current compute resource,
retains the workspace, allocates a new private generation, creates and verifies
the replacement, and returns a new opaque revision. Agent Controller blocks new
Runs around this command.

If replacement readiness cannot be confirmed after the old compute resource
was removed, the operation is `unknown`; the Agent remains unavailable and the
same request must be reconciled. Runtime Controller does not perform implicit
rollback.

## Disable

`POST /internal/runtimes/{agent_id}/disable`

Disable is valid only from `ready`. It removes the compute resource and retains
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

Delete is valid from `ready` or `disabled`. It removes compute when present,
then removes the owned workspace and records the Agent identity as `deleted`.
Deleted Agent identifiers cannot be initialized again. Partial deletion is
reconciled with the same request ID.

## Inspect And List

`GET /internal/runtimes/{agent_id}` returns the logical lifecycle state and
opaque revision. When state is `ready`, it reads current platform state and
performs one bounded Runtime status check. The response may contain MCP
endpoint, execution ID, health, restart count, and observation time. It never
contains physical generation, digest, container/Pod ID, volume ID, or platform
phase.

`GET /internal/runtimes` returns all non-deleted Runtime Environments. Deleted
identities remain private tombstones and can still be inspected directly by
Agent ID. The list is the authoritative recovery companion to a service-wide
observation gap. Every
`ready` Environment is checked against the private platform identity; drift
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
platform resource ID remain private. `runtime_missing` means a logical ready
Environment had no matching resource in a complete platform inventory. Agent
Controller decides each fact's business meaning.

## Status

`GET /status` reports process and dependency readiness:

```json
{"status":"ready","live":true,"ready":true,"database_ready":true,"platform_ready":true,"observation_ready":true}
```

One unhealthy Runtime does not make the service unready.

## Failure Semantics

| Condition | Result | Caller behavior |
| --- | --- | --- |
| Invalid command or lifecycle transition | failed / not_started | Correct request |
| Stale expected revision | failed / not_started | Reload Runtime and decide again |
| Definite platform rejection before mutation | failed / not_started | Correct input or platform state |
| Lost response after possible mutation | unknown / unknown | Retry the same request ID |
| Compute created but not status-ready | unknown / completed | Inspect and retry the same request ID |
| Confirmed complete deletion | completed / completed | Agent deletion may finish |

Errors use one stable JSON shape and never expose SQL, Docker socket paths,
credentials, environment values, Runtime output, or physical resource names:

```json
{"code":"runtime_revision_conflict","message":"Runtime revision is stale","retryable":false}
```
