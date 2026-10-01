# Runtime Controller Operations

## Runtime Requirements

The service requires:

- its private PostgreSQL schema for Runtime Environment heads, operation
  idempotency, immutable internal generation claims, cross-replica Agent locks,
  and the bounded observation journal;
- one selected deployment-platform adapter;
- Docker Engine access for the first implementation;
- network reachability to managed Runtime `/status` endpoints;
- a prebuilt Antnest Runtime image.

It does not depend on Runtime Egress, Agent ACP Service, or another Runtime
Provider service. Agent Controller supplies lifecycle commands and complete
Runtime configuration for Initialize, Update, and Enable, including the Egress
attachment already allocated for the Agent. It never supplies platform resource
identity or physical generation.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL` | yes | Controller-private PostgreSQL DSN |
| `ANTNEST_RUNTIME_CONTROLLER_LISTEN` | no | Go listen address; default `:8080` |
| `ANTNEST_RUNTIME_PLATFORM` | no | `docker`; default and only current adapter |
| `ANTNEST_DOCKER_HOST` | no | Unix Docker Engine URL; default `unix:///var/run/docker.sock`; TCP is rejected |
| `ANTNEST_RUNTIME_CONTROLLER_SCOPE` | no | Stable ownership scope written to every managed Runtime and workspace; defaults to the management-network name |
| `ANTNEST_RUNTIME_MANAGEMENT_NETWORK` | yes | Existing private Docker network shared with Runtime and internal callers |
| `ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME` | no | Existing read-only system-Skill volume name; defaults to `antnest-system-skills` |
| `ANTNEST_RUNTIME_STATUS_TIMEOUT` | no | Go duration; one `/status` bound; default `5s` |
| `ANTNEST_RUNTIME_MUTATION_TIMEOUT` | no | Go duration; complete mutation bound including lock wait; default `2m` |
| `ANTNEST_RUNTIME_RPC_TIMEOUT` | no | Go duration; finite internal RPC execution bound; default `3m` and must exceed mutation timeout |
| `ANTNEST_RUNTIME_RECONCILIATION_TIMEOUT` | no | Go duration; complete physical/logical inventory reconciliation bound; default `2m` |
| `ANTNEST_OBSERVATION_RETENTION` | no | Go duration; journal retention; default `168h` |
| `ANTNEST_RUNTIME_SSE_HEARTBEAT` | no | Go duration; internal SSE heartbeat; default `15s` |

Runtime Controller supports OTLP `http/protobuf` for traces, metrics, and logs.
Export is selected with `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=otlp|none` or by
setting a matching signal endpoint. The supported endpoint and protocol inputs
are `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, and their
`_TRACES_`, `_METRICS_`, or `_LOGS_` variants. `OTEL_SERVICE_NAME`,
`OTEL_RESOURCE_ATTRIBUTES`, and `OTEL_SDK_DISABLED` are also honored. A
configured protocol other than `http/protobuf` is rejected at startup. Trace
context propagation remains active when export is disabled.

Finite RPC spans retain the matched method/route through the request-deadline
wrapper. Inspect and Disable must remain distinguishable in Jaeger; matching
only the service name or an `unmatched` route is not lifecycle trace evidence.

`ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is the shared boolean content switch. Enabling it records complete RPC parameters and results, including credentials. New Runtime processes inherit the same value; there is no per-runtime override or custom body budget. Ordinary HTTP and streams never capture content. See [observability](observability.md).

The same supported keys prefixed with `ANTNEST_RUNTIME_` override values passed
to managed Runtime containers. This is required when the Controller can reach a
collector by service DNS but Runtime's direct platform-network policy requires
a literal IPv4 endpoint. For example,
`ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT=http://172.30.255.4:4318` affects
only Runtime containers; the Controller may continue to use
`OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318`.

Only the explicitly allowlisted trace/metric variables documented in
`internal/config` are copied into new Runtime containers. Controller log-export
configuration and exporter credentials are not forwarded.
Runtime Controller has no Runtime token secret, reverse-control listener,
Egress URL, or external authentication configuration.

The Docker adapter uses Engine API `v1.47`; operators must provide an Engine
that supports this API version.

## Ports And Networks

Runtime Controller exposes one trusted internal listener for health and RPC.
It does not bind a public host port outside an explicit development profile.

It must reach:

1. its private PostgreSQL database;
2. the Docker socket or Kubernetes API selected by its platform adapter;
3. managed Runtime `/status` endpoints.

It does not need to reach Runtime MCP, Runtime Egress control, or Egress packet
listeners.

## Readiness

Process liveness and application readiness are distinct operator signals even
if one HTTP status document exposes both fields.

Controller readiness requires:

1. private database connectivity and completed ordered migrations; migrations
   are serialized by a PostgreSQL advisory lock, committed transactionally,
   and refuse an unknown future schema version;
2. local adapter construction and required startup initialization have completed;
3. a rollback-safe observation journal insert/read probe succeeds without
   leaving a synthetic business fact;
4. a separately committed, payload-only notification probe traverses the
   active PostgreSQL LISTEN callback without entering the journal;

Platform inventory/Watch initialization still occurs at startup, but `/status`
does not call Docker or Runtime `/status`, and a later Docker Watch outage does
not make local readiness recursively depend on the deployment platform. The
legacy `platform_ready` field denotes successful local adapter initialization.
Network/volume failures surface on actual lifecycle calls. Runtime health and
startup failures surface on Inspect/List and observations, not creation.

One unhealthy Runtime does not make the Controller unready. Its state appears
in `InspectRuntime` and Runtime observations. Readiness never inspects every
Runtime; full inventory belongs only to reconciliation.

## Platform Health And Restart

Docker or Kubernetes owns Runtime liveness checks and restart policy. Runtime
Controller consumes platform events instead of polling every Runtime.

Managed Docker Runtimes use separate startup and steady-state health cadence:
`StartInterval=2s`, `StartPeriod=30s`, `Interval=10s`, `Timeout=2s`, and
`Retries=3`. Startup stays responsive; an already healthy idle Runtime no longer
forks a `curl` process every two seconds. Three consecutive failures are required
in steady state, with a nominal thirty-second failure window plus probe time.
Creation has no Runtime readiness budget. Each independent `/status`
verification is bounded by `ANTNEST_RUNTIME_STATUS_TIMEOUT`.

This uses Docker's standard
[startup health-check interval](https://docs.docker.com/reference/cli/docker/container/run/#options),
supported by the adapter's Engine API version. Docker restarts the startup
schedule after container restart. Health failure is an observation, not a claim
that Docker automatically restarts an unhealthy but still-running process.
Restart policy remains `unless-stopped`. Existing Runtimes receive the new
settings on explicit recreation, not through an implicit configuration mutation.

The repository's `health` lifecycle profile exercises these settings on a
disposable Runtime created through the real Gateway and Controllers. It records
idle cgroup/PID-1 CPU, a three-second unprivileged CPU calibration and the return
to idle, then verifies unhealthy/healthy transitions and fast readiness after
restart. It retains only final metrics and cleans its own labelled resources.

Startup timing is measured from the current `State.StartedAt` to a successful
probe that started at or after that timestamp. Retained health logs from a
previous process must not count as evidence that the new process is ready.

```sh
docker compose build runtime-controller
node tests/e2e/lifecycle-closeout/run.mjs health
```

The profile needs the other local Stage 3 images and shared Node test dependencies
from the platform quickstart. The calibration is a bounded test workload, not
an LLM performance benchmark. Docker CPU percentages are relative to one CPU,
not the sum of all host CPUs.

When the platform reports a new Healthy process, the Controller performs one
bounded `/status` verification and records the returned `execution_id`. A Watch
disconnect triggers List/Inspect reconciliation followed by Watch resume.

The Controller records a service-wide `observation_gap`, reconciles physical
List/Inspect in both directions against logical provisioned Runtime heads, then
records service-wide `reconciled`. Missing expected compute is an explicit
`runtime_missing` fact. This remains visible when no Runtime exists. A
`/status` failure is `status_unverified`, not a fabricated platform `unhealthy`
fact.

Across Controller replicas, PostgreSQL elects exactly one platform-Watch
consumer. Followers continue serving control and observation RPCs and take over
after leadership loss. Transactional PostgreSQL notifications wake each
replica's local SSE clients; reconnecting clients always resume from the
durable sequence and never rely on notification delivery.
Observation SSE connections retain one HTTP SERVER span until delivery ends,
plus existing lifecycle metrics; each finite journal read remains traced.
If a consumer cursor falls outside the configured retention window, List or
Watch returns `observation_cursor_expired`. The consumer performs a full Runtime
List, then resumes from the returned reset sequence.

## Coordinated Resources

Resource names and labels are deterministic from Agent identity, private generation,
Controller ownership scope, and the effective physical specification digest. List,
Watch, adoption, and deletion ignore resources belonging to another scope, so
independent deployments may safely share one Docker daemon. Operators must keep a
scope stable for a deployment and assign distinct scopes to independent Controller
databases. This digest includes
Controller-injected Docker configuration, so changing a management network,
mount source, Runtime telemetry environment, privilege set, healthcheck, or
restart policy requires a new private generation. Each lifecycle mutation
acquires one PostgreSQL Agent lock, so compute and workspace substeps cannot interleave
across Controller replicas. Lock sessions use a small dedicated database pool
and do not consume repository query capacity. The same database session is
probed while its callback runs. Session loss cancels the callback and returns
`mutation_lock_lost`; callers retry the same `Idempotency-Key`. The private
database also admits only one `running` or `unknown` operation per Agent, so a
different request returns `agent_mutation_in_progress` instead of overtaking an
ambiguous effect. An exact recovery increments a private attempt number;
terminal persistence is attempt-checked, and Docker create conflicts are
re-inspected before exact resources are adopted. The Docker adapter owns:

- one current Runtime container per Agent, labeled with its Controller scope and generation/digest;
- Agent-scoped persistent workspace volume association;
- system Skill mounts injected by Runtime Controller;
- internal network attachment and Runtime endpoint discovery;
- platform health configuration.

An interrupted Update may already have replaced the old compute. Retry the
same request/body/key: the service observes the recorded source and converges
only the target claimed by that operation. A target already present is reused,
not deleted using the old generation. Retained workspace ownership is checked;
application readiness is independent from command completion. A stopped source, mismatched identity or unreadable
platform cannot be restored as the executable old revision. Only a definitive
source deletion rejection followed by matching running-resource reinspection
can retain a provisioned source. No additional migration or operator-supplied phase is
required for this recovery behavior.

Migration 4 adds `failed` to the owned Environment and operation source states;
earlier migration checksums remain unchanged. Definitive Initialize failures
retain revision/generation ownership instead of erasing the Environment while
leaving a workspace behind. Inspect that failed revision and use Delete to
clean it; do not retry with a new Initialize key. Migration 6 separates creation
from current health: confirmed create/start returns `provisioned` and releases
the mutation slot. Later startup/status failures belong to observation, not
creation failure. Unknown physical effects remain nonterminal and still require
exact-request reconciliation.

Migration 4 changes constraints, not historical ownership data. It does not
reconstruct Environment heads erased by failed Initialize operations under
migration 3. This batch verifies failures created with migration 4 on an empty
test database; it does not claim recovery of older orphaned resources. Existing
deployments with such resources require separate operator reconciliation.

Initialize creates workspace plus compute. Update replaces compute while
retaining workspace. Disable removes compute while retaining workspace. Enable
recreates compute. Delete removes compute and then workspace. No workspace
operation is exposed to another service.

Workspace volumes carry Antnest managed, Controller-scope, and Agent ownership labels. A same-name
volume without exact labels is never adopted, mounted, or deleted. System Skill
storage is deployment-owned and only checked for existence.

Runtime containers are handled by the same rule: normal Inspect/List/Delete
requires exact managed, Agent, generation, and persisted-digest identity. A
managed container with malformed labels blocks reconciliation until an operator
repairs or explicitly removes the drift.

Operators should prefer Runtime Controller RPCs over manual platform mutation.
Manual changes are still detected through platform List/Watch and surfaced as
drift observations.

## Failure Diagnosis

1. Check Controller readiness for local initialization/database failure, then
   inspect actual platform/lifecycle failures separately.
2. Inspect the Agent Runtime and read observations after the last known sequence.
3. Correlate Runtime revision, operation ID, trace ID, and execution ID in
   cross-service logs. Adapter logs additionally carry private generation and
   platform resource ID.
4. Treat `unknown` mutation results as ambiguous. Inspect current platform state
   with the original operation identity; do not issue a compensating mutation
   blindly.
5. A platform-Healthy Runtime with a failing `/status` is not Ready.
6. A changed execution ID under the same Runtime revision indicates process
   restart, not a lifecycle update.
7. A Watch gap is not evidence of a known restart count or cause.
8. `status_unverified` means platform state was observed but Runtime identity or
   readiness could not be confirmed; it is not equivalent to unhealthy.
9. `mutation_lock_lost` means coordination failed during an operation. Inspect
   and retry only the same request ID. `agent_mutation_in_progress` means a
   distinct non-terminal request still owns the Agent mutation slot.
10. Observation sequence is a sparse cursor. Do not infer loss from a numeric
    jump; consume explicit `observation_gap` records and recover with List.
11. `observation_cursor_expired` is unrelated to a platform Watch gap. Rebuild
    the consumer projection from Runtime List before using `reset_sequence`.

## Stage 1C Acceptance

The service is operationally acceptable only when it proves:

1. deterministic idempotent Initialize/Update/Disable/Enable/Delete and Inspect
   in an empty Docker setup;
2. reconstruction from the private store plus platform labels after Controller
   restart;
3. ordered observation recovery after Watch disconnect, including empty
   inventory;
4. one-shot status verification after Healthy without a permanent polling loop;
5. same-revision Runtime restart produces a new execution observation and
   rejects the stale execution fence;
6. no separate Docker Provider, reverse Runtime channel, Work lease, MCP proxy,
   or Egress dependency remains.

`make test-runtime-controller-postgres` proves the private repository against a
real disposable PostgreSQL database. `make e2e-runtime-controller` builds the
actual images and proves items 1, 2, 4, 5, and complete lifecycle deletion in
an isolated disposable Compose project. Unit tests cover Docker List/Watch
normalization, Agent-level mutation serialization, owned-volume handling, and
Watch-gap reconciliation.

## Expected Docker absence in traces

The initial workspace lookup in EnsureStorage, the initial container lookup in
Create, and Driver.Inspect's container lookup treat HTTP 404 as expected absence.
Inspect already returns a successful absent observation for this result. Their HTTP CLIENT spans
retain status 404 and `antnest.outcome=absent`, with unset span status and no
error event. The expectation applies to that single Docker GET, not subsequent
requests. Required storage/image/network lookups, post-create verification,
mutations, HTTP 5xx, transport errors and response read/close failures keep their
existing error semantics. No Docker request, retry, timeout or domain outcome
changes. Creation consumers must still require successful allocation after
absence. Missing-source Rebuild consumers must correlate the old absent generation
with successful allocation/start of its replacement. See the
[Inspect contract](inspect-absence-contract.md).
