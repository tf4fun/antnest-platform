# Creation And Runtime Observation

Creation is a command; readiness is a current observation. Initialize, Update
and Enable complete after Docker has confirmed the requested create/start and
the Controller has committed the result. They do not wait for Docker health or
Runtime `/status`. The lifecycle state is `provisioned`, not `ready`.

## Contract

Current inspection includes a normalized compute `phase`
(`absent/created/running/exited/unknown`), `health`, `reason`, diagnostic detail
and `observed_at`. A container that has never started is not an exited process.
Restarting or paused compute does not inherit stale healthy evidence. These are
observations, not Agent lifecycle or authorization decisions. In particular,
disabled compute being absent is expected, while an enabled target being absent
may require repair. Consumers make that distinction using their business intent.

- A completed command records its target revision, original image reference and
  resolved image ID. Its inspection is the completion snapshot, with unknown
  health and no asserted execution identity. Replaying the command returns that
  same result, not a fresh health check.
- Inspect/List and the independent platform observer report current health.
  A healthy result requires the matching Runtime `/status` execution identity;
  a known endpoint alone is not proof of readiness.
- Startup delay, an unhealthy process or a failed status check never rewrites a
  completed command. They do not retain the command's mutation slot. Update,
  Disable and Delete remain available for a provisioned but unhealthy Runtime.
- Platform create/start failure and ambiguous platform effects remain command
  failures/recovery concerns. Resource ownership, revision checks and stable
  retry identities still apply. No health check can prove an ambiguous deletion
  did not happen; source retention requires a fresh matching resource check.

## Independent Observation

Reuse the existing Docker inventory/watch and observation journal. Starting and
unverified states must not be published as healthy. Explicit Inspect/List also
return a current snapshot, allowing consumers to reconcile missed or early
events. An observation never completes a lifecycle command or changes its
target revision. Generation claims continue to be committed before Docker
mutation so events arriving before the command response have an owner.

Agent Controller commits creation/configuration independently from availability.
It must not publish an executable binding from a completed creation response.
Its observation/reconciliation path verifies the current target revision and
publishes the executable binding when ready. Before then the Agent exists but
cannot acquire a Run. Early/repeated observations and consumer restart must
converge through a fresh current-state snapshot; they must not rely on receiving
one particular healthy event after creation completes.

## Verification

1. Initialize/Update/Enable complete without calling the Runtime verifier, even
   when `/status` is unavailable. The mutation slot is released.
2. Later healthy/unhealthy/absent observations do not mutate the saved command
   result. Inspect can report startup failure while the command remains complete.
3. Starting resources can be updated, disabled and deleted. Resource identity
   conflicts and incomplete destructive effects still reject unsafe mutations.
4. A stale healthy event rechecked as starting is not retained as healthy.
5. Agent Controller does not admit Runs before a matching ready snapshot;
   early events, repeated reconciliation, stale revisions and restart converge.

Delivery order: Runtime Controller contract/tests/code, then Agent Controller
consumer/tests/code, then Docker integration and updated business-flow traces.
One producer batch alone is not end-to-end completion.

## Delivery Boundary

Runtime Controller batch verification: `make fmt-check`, `make lint` (zero
issues), the full Go suite with a real isolated PostgreSQL database, and
[`creation-observation-e2e.mjs`](../../../tests/e2e/runtime-controller/creation-observation-e2e.mjs)
against a separately built Docker Controller passed.
The migration test covers completed, running, unknown and failed predecessor
operations. The Docker test uses the existing Runtime image and an allocated
Egress network, without invoking an external model. Test resources are removed.

The Agent Controller consumer now separates configured resources from executable
bindings, completes creation before readiness, and reconciles pending bindings
through current observations. Never-ready Agents remain rebuildable, disableable
and deletable without fabricated execution history or a readiness-waiting
Temporal activity. See its [availability contract](../../agent-controller/docs/runtime-availability.md).

Both service batches precede deployment integration. The development stack has
not yet been replaced for this contract. Deploy the matching producer and
consumer together, then run Gateway lifecycle scenarios and update traces and
sequence diagrams with fresh evidence; existing traces describe the old behavior.

## Focused Docker Verification

`make e2e-observation` from the service directory runs against an independently
started test Controller. The equivalent command from the repository root is
`node tests/e2e/runtime-controller/creation-observation-e2e.mjs`.
It creates a unique Agent, observes readiness separately, checks exact command
replay, then updates/disables/enables/deletes without intervening readiness waits.
It does not require Agent Controller, ACP, an external Provider or a second
PostgreSQL server.

Set `ANTNEST_RUNTIME_CONTROLLER_TEST_URL` and
`ANTNEST_RUNTIME_TEST_CONFIGURATION` (the complete configuration JSON). Allocate
a test network in Egress first and set `ANTNEST_RUNTIME_TEST_AGENT_ID` to its
Agent ID: inventing a Tunnel IP will intentionally fail Runtime startup probes.
The caller owns the isolated Controller container/database and Egress attachment,
and must release them afterwards. The script deletes its Runtime and workspace
in its cleanup path. Never aim it at the production Controller.

Operation response timestamps use PostgreSQL's microsecond precision so the
initial response and persisted replay have the same representation. Runtime
health and execution identity remain only in the independent current snapshot.
