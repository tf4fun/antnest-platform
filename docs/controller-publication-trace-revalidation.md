# Controller publication Trace follow-up

Date: 2026-09-17. This service-owned fix follows the SQL evidence gap found by
[RPC response-loss revalidation](rpc-response-loss-revalidation.md). The shared
[publication tracing contract](../services/agent-controller/docs/execution-publication.md#background-publication-trace-contract)
was written before tests and code. ACP, Runtime, Gateway and Console implementations
are unchanged in this batch.

## Change and service gates

The publication worker retained a `SpanContext`, which identifies a causal parent
but does not itself record work. Controller's standard database instrumentation
deliberately suppresses SQL without a recording parent. Consequently the real ACP
HTTP call was visible while the background source read and acknowledgement UPDATE
were missing.

Each bounded organization attempt now creates one
`agent_controller.execution_publication` INTERNAL span. Its existing driver and
HTTP calls inherit that recording context. Only a successful, persisted reply
adds `antnest.configuration.applied_revision`; failures record a static error
classification without serializing dependency errors or credentials. Each retry
gets a distinct span with the retained commit parent. Startup/periodic attempts
get fresh roots. Cancellation, deadlines, publication ordering and retry scheduling
retain their existing behavior. The worker obtains its tracer at composition,
so it cannot retain a prior telemetry runtime across a fresh service composition.

The database tracer's no-parent behavior is unchanged. This adds no per-query
application wrappers or unbounded pool/prepare/enumeration tracing. Lifecycle
publication remains under its existing Temporal activity.

Tests first reproduced the missing recording parent and missing ended attempt.
After the fix, Controller's full 15-package suite passed with `-race`, including
real PostgreSQL and HTTP/component contracts. The new component case drops the
first real HTTP response: both attempts read the current database source, only
the delivered attempt emits the acknowledgement UPDATE, and neither keeps the
source transaction open during HTTP. The composed-tracer test also verifies
fresh periodic roots, original causal parents, distinct retries, error privacy
and deadline completion. Existing unparented-SQL suppression checks still pass.
`golangci-lint` reports zero issues.

The independent candidate image is
`sha256:e7d6da966ebd4e3af1520c41f1612469556b8ccfc0e5e313217c4a67bdb6b69d`
(`antnest/agent-controller:publication-trace-20260917`). It was built with the
service Dockerfile. The retained development container and `:local` tag are not
replaced by this isolated validation.

## Integration gate

The RPC fixture now requires each actual publication HTTP CLIENT to belong to
its own recording attempt, with the exact organization, a current source SELECT,
no acknowledgement on the dropped attempt and one correctly owned UPDATE after
the delivered acknowledgement. Missing/foreign/premature writes fail the oracle;
the former missing-SQL exception is removed. Only the exact dropped HTTP and its
failed publication span are accepted as injected errors. All 18 fixture tests
pass. The candidate is selected with `ANTNEST_E2E_CONTROLLER_IMAGE`, keeping this
integration separate from a development deployment.

```sh
ANTNEST_E2E_CONTROLLER_IMAGE=antnest/agent-controller:publication-trace-20260917 make e2e-rpc-response-loss
```

Strict Trace warnings and lifecycle Docker probe errors retain their nonzero
gate. Closing this SQL evidence gap does not waive those failures or accept ACP
database commit-receipt loss/interrupted-Run recovery, which belongs to the next
fixture migration batch.

The isolated project `antnest-stage3-e2e-98542` passed all four response-loss
business cases and all 28 scoped topology/privacy checks. Four publication
attempt spans contain their current source reads; the two delivered retries
contain exactly two acknowledgement UPDATEs. There are zero missing-SQL gaps.
Eight injected/consequent error spans match four dropped HTTP responses, two
publication attempts and two drain activities. The strict gate still fails on
11 traces: eight traces have 4,403 repeated warning entries, and four lifecycle
Docker absence-probe ERROR spans remain errors. Categories can overlap and
warning entries are not independent faults. ACP did not restart; Agent deletion
and parent cleanup removed all owned containers, volumes and networks. The
retained 12-container development baseline remains unchanged.

Local service, fixture, lint and image-build logs are in
`artifacts/verification/publication-trace-20260917/`. The service test runner created only a
temporary PostgreSQL container and removed it and its volume after verification.
The RPC runner's compact metrics are in
`artifacts/verification/legacy-acceptance-20260917/rpc-docker-4.log`; complete traces and actual
correlation inputs remain private under `artifacts/verification/rpc-response-loss/<project>/`.
