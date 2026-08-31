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
Agent mutation slot. Only the original request ID may reconcile it.

All mutations for one Agent are serialized across Controller replicas. The
PostgreSQL lock session is monitored while a mutation runs. A database
invariant permits only one `running` or `unknown` operation per Agent.

## Runtime Configuration

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

`GET /internal/runtimes` returns all non-deleted Runtime Environments. It is the
authoritative recovery companion to a service-wide observation gap. Every
`ready` Environment is checked against the private platform identity; drift
fails the request instead of being silently omitted.

## Operations

`GET /internal/runtime-operations/{request_id}` returns the immutable request
identity, operation kind, current state, effect state, resulting Runtime
revision, logical Runtime inspection, and sanitized failure. A process crash
may leave `running`; retrying the original mutation with the same request ID
reconciles platform resources. `unknown` never means absent or safe to replay
under a new request ID.

## Observations

`GET /internal/runtime-observations?after_sequence={n}&limit={n}` returns an
ordered page from the bounded Controller journal.

`GET /internal/runtime-observations/watch?after_sequence={n}` returns
`text/event-stream`. Watch is only a low-latency wake-up path: clients first
read List, consume Watch, and return to List after disconnect. Delivery is at
least once, so callers de-duplicate by sequence.

Runtime-scoped observations expose Agent ID, opaque revision, event kind,
execution ID when known, diagnostic summary, and time. Physical platform
identity remains private. `observation_gap` and `reconciled` are service-wide
facts without Agent identity. Agent Controller decides their business meaning.

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
