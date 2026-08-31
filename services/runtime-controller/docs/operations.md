# Runtime Controller Operations

> Status: implemented Docker operations model<br>
> Updated: 2026-08-31

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
| `ANTNEST_RUNTIME_MANAGEMENT_NETWORK` | yes | Existing private Docker network shared with Runtime and internal callers |
| `ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME` | no | Existing read-only system-Skill volume name; defaults to `antnest-system-skills` |
| `ANTNEST_RUNTIME_STATUS_TIMEOUT` | no | Go duration; one `/status` bound; default `5s` |
| `ANTNEST_RUNTIME_MUTATION_TIMEOUT` | no | Go duration; complete mutation bound including lock wait; default `2m` |
| `ANTNEST_RUNTIME_READY_TIMEOUT` | no | Go duration; compute readiness bound; default `1m` |
| `ANTNEST_RUNTIME_POLL_INTERVAL` | no | Go duration; compute readiness inspection interval; default `500ms` |
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
2. the selected platform adapter can perform a lightweight managed-resource
   list permission probe;
3. the configured Docker management network exists;
4. the configured system-Skill volume exists;
5. a rollback-safe observation journal insert/read probe succeeds without
   leaving a synthetic business fact;
6. a separately committed, payload-only notification probe traverses the
   active PostgreSQL LISTEN callback without entering the journal;
7. a deployment-platform Watch has completed its response handshake and holds
   the shared readiness lease; leadership without an active Watch is unready.

One unhealthy Runtime does not make the Controller unready. Its state appears
in `InspectRuntime` and Runtime observations. Readiness never inspects every
Runtime; full inventory belongs only to reconciliation.

## Platform Health And Restart

Docker or Kubernetes owns Runtime liveness checks and restart policy. Runtime
Controller consumes platform events instead of polling every Runtime.

When the platform reports a new Healthy process, the Controller performs one
bounded `/status` verification and records the returned `execution_id`. A Watch
disconnect triggers List/Inspect reconciliation followed by Watch resume.

The Controller records a service-wide `observation_gap`, reconciles physical
List/Inspect in both directions against logical ready Runtime heads, then
records service-wide `reconciled`. Missing expected compute is an explicit
`runtime_missing` fact. This remains visible when no Runtime exists. A
`/status` failure is `status_unverified`, not a fabricated platform `unhealthy`
fact.

Across Controller replicas, PostgreSQL elects exactly one platform-Watch
consumer. Followers continue serving control and observation RPCs and take over
after leadership loss. Transactional PostgreSQL notifications wake each
replica's local SSE clients; reconnecting clients always resume from the
durable sequence and never rely on notification delivery.
Observation SSE connections use lifecycle metrics rather than one
connection-duration trace span; each finite journal read remains traced.
If a consumer cursor falls outside the configured retention window, List or
Watch returns `observation_cursor_expired`. The consumer performs a full Runtime
List, then resumes from the returned reset sequence.

## Coordinated Resources

Resource names and labels are deterministic from Agent identity, private generation,
and the effective physical specification digest. This digest includes
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

- one current Runtime container per Agent, labeled with its generation/digest;
- Agent-scoped persistent workspace volume association;
- system Skill mounts injected by Runtime Controller;
- internal network attachment and Runtime endpoint discovery;
- platform health configuration.

Initialize creates workspace plus compute. Update replaces compute while
retaining workspace. Disable removes compute while retaining workspace. Enable
recreates compute. Delete removes compute and then workspace. No workspace
operation is exposed to another service.

Workspace volumes carry Antnest managed and Agent ownership labels. A same-name
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

1. Check Controller readiness to separate platform/database failure from one
   Runtime failure.
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
