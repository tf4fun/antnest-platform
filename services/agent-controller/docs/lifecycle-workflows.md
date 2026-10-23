# Agent lifecycle workflows

This document describes how the five Agent lifecycle commands run as Temporal
workflows, which guarantees each Activity relies on, and how the workflows are
verified.

All five commands use Temporal. PostgreSQL retains Agent state, immutable
snapshots, request fingerprints, business phases, results and audit events. It
does not schedule work or retain worker leases, retry counters or trace carriers.

| Command | Activities after admission                                     |
| ------- | -------------------------------------------------------------- |
| Create  | network_ensure, runtime_initialize, publish                    |
| Rebuild | drain, network_fence, runtime_update, network_ensure, publish  |
| Disable | drain, network_fence, runtime_disable, publish                 |
| Enable  | network_ensure, runtime_enable, network_restore, publish       |
| Delete  | drain, network_fence, runtime_delete, network_release, publish |

Delete skips Runtime deletion when the persisted source proves Runtime absence.
An Identity owner revocation submits the same Disable workflow as the HTTP path;
it does not call the application admission function directly.

## Execution contract

1. The SDK starts a deterministic workflow ID before the admission Activity.
2. A Workflow Update returns the committed admission result (HTTP 202), without
   waiting for resource work. A disconnected caller does not cancel execution.
3. Each Activity performs one business stage. Stable child request IDs
   prevent duplicate downstream effects after an uncertain response. Transaction
   row locks, fingerprints, phase CAS and aggregate revisions remain necessary:
   Temporal Activities are at-least-once, not exactly-once.
4. A completed phase replays its result without repeating its effects. Temporary
   dependency errors and pending effects retry in Temporal. Definitive failures
   are persisted by the application and end the workflow; later stages do not run.
5. A network write based on a fresh read revalidates the persisted operation
   phase before issuing the resource-version CAS. A delayed Activity cannot use
   a newer attachment to mutate a later lifecycle. An ambiguous attachment-open
   response retries with the same expected version, without a compensating close
   that would invalidate its own idempotency key.
6. Rejected admission retains command identity in Temporal history even without
   a business row. An altered retry is a request conflict, not a dependency error.
7. Official SDK interceptors carry tracing across the asynchronous boundary;
   SQL and RPC instrumentation supplies descendants. Business stages do not start
   spans. Worker shutdown cancels Activities; the engine resumes retryable work.

### Creation does not wait for readiness

Create, Rebuild and Enable complete after platform resource creation and network
configuration. They publish the Agent as `created/enabled`, Runtime `unknown`, without an
execution binding. The observation worker publishes `agent_ready` only
after a fresh matching healthy inspection. There is no readiness-waiting Activity
or second Temporal workflow. Pending readiness does not hold a lifecycle operation
slot; rebuilding, disabling or deleting an unhealthy configured Runtime remains
possible. See [Runtime availability](runtime-availability.md).

### Versioned readiness event readers

The application event reader accepts mixed pages and notification-driven watches
containing the twenty existing version-1 event types and the version-2
`runtime_bound` and `agent_ready` proofs defined by the
[readiness contract](../../../contracts/agent-controller/readiness.md).
Version-1 data keeps its historical object shape. Version-2 data admits exactly
the documented binding identifiers and positive JavaScript-safe revision numbers;
only `agent_ready` includes `applied_revision`. Unknown versions, event types and
proof fields remain invalid. A malformed row rejects the complete page before
any event in that page is emitted or its cursor is advanced. HTTP and SSE retain
the original envelope, proof and sequence values.

This is reader compatibility, not a readiness decision. The reader does not
infer current authorization or binding eligibility from a historical proof, and
does not compare the acknowledgement to the binding threshold. Those checks
belong to the future owning transaction. The current storage constraints and
producer still use version 1; version-2 persistence, ACK-gated production, ACP
preparing admission and the client and Docker acceptance batches remain pending.

### ACP owns execution settlement

Drain publishes the current closed Agent configuration and confirms ACP applied
it before calling the Agent-level settlement RPC. Rebuild and ordinary disable
wait; deletion and identity revocation request cancellation. The original
persisted deadline bounds publication, settlement and the confirmation write.
Only a confirmed `settled` or `runtime_barrier_required` result advances the
management operation. ACP owns the execution details and any remaining stop
protection. Controller never releases Runs or interprets Tool effects.

The publication gate is not held during settlement. Runtime effects remain
ordinary lifecycle stages, not calls back into ACP's Run state. Management
failure may preserve the old configuration, but cannot reopen its attachment
when ACP required a Runtime barrier or the owner was revoked. New Runtime
creation is still separate from readiness and successful configuration delivery.

### Failed deletion and explicit retry

A Delete drain deadline or a Runtime `failed / not_started` result ends that
attempt with its original diagnostic. The confirmed lifecycle is retained with
`desired_state=deleted`; network allocation is not released,
and it is not returned to service. The operation is terminal and the active
operation slot is cleared. Unknown effects still require authoritative inspection.
The administrator's current fleet retains this failed cleanup; only a completed
`lifecycle_state=deleted` moves to the retained view. User workspace admission
continues to exclude the deletion intent.

Replaying the same request returns the same failure. An explicit retry uses a
new request identity and resolves the current Runtime revision after fencing,
rather than reusing a stale failed attempt's source. The Console distinguishes
retrying an unknown HTTP result from issuing a new command after observing its
terminal operation, including when the original HTTP response was lost.

### Rebuild stage persistence boundary

`AdvanceAgentRebuild` returns only the committed Agent/Operation projections and
no Run completion or release result. The application retains the already-loaded immutable source
and target snapshots. Each phase write must match the running operation's phase
and the Agent's active operation identity in the same transaction. A detached or
replaced operation cannot persist a Runtime result, even if its own phase still
matches. This is management aggregate ownership, not Run admission. Reusing the
loaded snapshots avoids three snapshot SELECTs in each of the three advance
calls; initial stage recovery and final publication still load their required
snapshots.

## Runtime barrier recovery

The observation worker reads ACP's current durable barrier under the Agent's
current binding and organization policy. `auto` admits a deterministic Rebuild
for that barrier; `notify` records one durable `agent_runtime_barrier_required`
event without admitting a lifecycle operation; `manual` records the current
recovery projection without a notification or automatic Rebuild. Policy defaults
to manual. Observation and start workers are bounded and stop with the service.

An administrator confirms manual recovery through the existing Console Rebuild
endpoint with the configured Template and expected original Runtime revision.
Admission revalidates the binding and policy and freezes the original actor,
request fingerprint, receipt and cooldown. Repeated queries or explicit retries
retain that identity. The pending start is confirmed only against the matching
Temporal command; operation completion still follows the ordinary Rebuild plan.
Runtime replacement does not re-execute the interrupted Prompt or Tool, and its
unresolved audit history remains unchanged. The
[restart profiles](../../../tests/e2e/acp-restart/README.md) require actual fault,
browser, persistence and cleanup evidence for the whole recovery workflow.

## Verification

Tests must cover all five plans, early admission, request conflicts, retries,
terminal failures, skipped deletion, identity-triggered disable, phase replay and
stale phase rejection. PostgreSQL component tests retain the lifecycle
invariants. Real-engine tests exercise Worker replacement for each of the five
commands, expired network-phase rejection, an attachment-open response lost
after effect completion, and changed arguments after rejected admission.

`TestTemporalResumesAfterBusinessCommitBeforeActivityAcknowledgement` combines
real PostgreSQL and Temporal: stop a Worker after the Delete stage transaction
commits but before Activity completion is acknowledged, then use a replacement
Worker. Runtime deletion, network release and final audit publication must each
occur once. Downstream effects use test doubles; this is not a Docker SIGKILL test.

The binary deliberately contains no fallback PostgreSQL worker. Migration
`0009` removed the earlier scheduler and trace-carrier columns and indexes;
completed business and audit records are retained.

The lifecycle exerciser runs all five commands against a development
deployment through Edge Gateway and checks Gateway-rooted Jaeger ancestry:
admission ancestry, official workflow/Activity spans, phase ordering,
successful downstream RPCs with exact server route and method under each owning
Activity, and SQL ancestry. Run it from the repository root with an existing
valid Template; the script creates and deletes only its own Agent:

```sh
node tests/e2e/observability/exercise-lifecycles.mjs \
  --confirm-development --template TEMPLATE_ID --revision REVISION \
  --resolve-evidence-directory artifacts/verification/observability/lifecycles
```

Credentials and effective Resolve TTL/RPC capture settings are read from `.env`
(exported environment settings take precedence). Enable RPC content capture for
the Runtime command evidence. Gateway admission is validated against its actual
`rpc/cache/shared` source, independently of Controller owner authorization and
workflow SQL. The collector archives three complete snapshots privately in the
explicit evidence directory; legal receiving RPC payloads may contain credentials.
Only compact identities and summaries are printed. Strict trace diagnostics keep
a nonzero exit code even when the owning workflow accepts a completed retry.
See the [observability contract](../../../docs/observability-contract.md) for the
fixed sampling policy and the separate creation/readiness and offline commands.
