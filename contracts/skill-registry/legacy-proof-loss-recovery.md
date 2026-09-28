# Legacy Skill proof-loss recovery (Controller C2 accepted locally)

This operation recovers only an Agent quarantined with
`legacy_migration_proof_lost` after an explicit migration changed its Runtime.
It does not accept an unproven pre-cutover source, repair arbitrary Runtime
drift, validate a new export, or resolve the legacy migration marker. Ordinary
Disable, Enable and Rebuild remain subject to their existing source and legacy
gate checks.

## Admission and identity

`POST /internal/agents/{agent_id}/legacy-system-skills-migration/proof-loss-recovery`
requires a trusted internal administrator caller, `Idempotency-Key`,
`organization_id`, `actor_principal_id`, and
`failed_migration_request_id`. The response identifies the durable recovery
operation and its current state. The same key and body replay it; a changed
body under the same key is a conflict. A different recovery request cannot
overtake an active recovery for the Agent.

Controller admits it only when all of these facts agree under the Agent lock:

- The Agent is still in the same organization, its migration marker is
  `pending`, `failure_code` is `legacy_migration_proof_lost`, and ordinary
  execution admission is closed.
- The named migration operation belongs to that Agent, is terminal `failed`
  with the same error code at `publish`, and has a proven target Runtime result.
  The operation's immutable target Runtime revision is the recovery target;
  its completion receipt may precede a health observation and contain no
  process ID. The stale Agent `runtime_revision` is not used to select a
  container.
- RC inspection shows that same target Runtime revision and a currently
  observed process identity. RC's Disable admission must reject any unrelated
  mutation in progress. A process restart under the same RC revision does not
  prevent retiring that target. Egress
  inspection confirms the Agent's attachment is closed. An absent, foreign,
  differently revised, or ambiguous target fails closed without treating it
  as an empty source.

Proof expiry or key revocation that caused the quarantine is historical
evidence, not authority for recovery. This operation never reuses that proof
to publish migration or open Egress. It records the administrator, failed
migration identity, observed RC identity, Egress state, and request fingerprint
before the first Runtime effect.

The request and receipt use the closed
[v1 JSON schema](legacy-proof-loss-recovery.schema.json). Admission returns
`202` with `state=running`; exact replay returns the stored receipt with `200`
when complete, `202` while running, or `409` when manual recovery is required.
The existing organization-scoped
operation query exposes the same receipt after a client timeout. Before an
operation is admitted, these errors leave no journal or Runtime effect:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 404 | `agent_not_found` | Unknown or foreign-organization Agent/failed operation |
| 409 | `request_id_conflict` | Same key, different request bytes |
| 409 | `lifecycle_conflict` | Other active lifecycle/recovery or changed Agent/marker |
| 409 | `legacy_proof_loss_recovery_not_applicable` | Agent is not quarantined by the named proof-loss operation |
| 409 | `legacy_migration_manual_recovery_required` | RC target is absent, changed or cannot be attributed to the failed operation |
| 503 | `dependency_unavailable` | RC/Egress cannot be inspected conclusively |

## Effect and publication

Controller invokes RC's existing Disable Runtime operation with a child
request ID derived from the recovery request and the **inspected target**
revision. RC preserves the Agent workspace and retained Skill collections.
Controller accepts only RC's exact completed disabled receipt; a timeout or
unknown effect keeps the recovery operation running and retries the same child
request. It must not infer success from a missing container or create a new
Runtime. Before publication, Controller rechecks that Egress remains closed,
the Agent and migration marker still match the admitted state, and RC's
disabled revision is the result of the same child request.

Publication is one transaction: clear the quarantined executable binding,
record the disabled RC revision, set desired and activation state to disabled,
clear the proof-loss failure only after the disabled effect is proven, append
an `agent_legacy_proof_loss_recovered` audit event containing the recovery
request, failed migration request, actor, and disabled RC revision, and
complete the recovery operation. The legacy marker remains
`pending` and retains its choice/history. The failed migration operation and
its proof are never rewritten. Ordinary Enable stays blocked; a new explicit
migration operation must use a fresh valid attestation and the current choice
to prepare a target and release the gate. Replay returns the original recovery
receipt without repeating the RC effect.

If an identity or network check fails after a possible Runtime effect,
Controller keeps Egress closed and the recovery journal running while the
exact RC child request is still unknown. Once RC definitively rejects that
child request, or a recorded completed disable cannot be published because
the attachment changed, Controller records `manual_recovery_required` with a
bounded reason. It must never mark the Agent disabled on a merely plausible
RC state. The receipt and same-key replay expose the manual state while the
quarantine, operation reservation, and migration marker remain intact. A separate
operator procedure must handle that wider drift; this endpoint does not erase
or adopt foreign compute.

The durable receipt states are `running`, `completed`, and
`manual_recovery_required`; phases are
`verify`, `disable_runtime`, `publish`, and `done`. A completed receipt binds
the original failed migration ID, its target Runtime revision, the completed
RC child request ID, and the resulting disabled Runtime revision. No client
supplied revision can replace these journaled identities. The publication
transaction must reject a concurrent change to the Agent aggregate sequence,
failed operation, migration marker or target RC result.

## Delivery and acceptance

1. **C0 shared contract:** this document and schema freeze the external
   operation identity, journal states, conflicts and audit meaning. RC and
   Egress APIs are existing consumers; no new method is implied. The main
   Controller contract catalog is updated with C1 when the route exists.
2. **C1 Controller:** test first, then implement the durable admission,
   Temporal replay, RC/Egress checks, publication transaction, HTTP contract
   and Controller documentation. Preserve current Disable/Enable/Rebuild gates.
3. **C2 integration:** in disposable Docker, revoke the migration key at
   publish, recover the proven target to disabled with Egress closed, verify
   workspace and Skill retention, then submit a fresh proof and finish the
   controlled Enable. Fault cases cover stale RC revision, changed process,
   missing container, unknown Disable result, concurrent recovery, exact
   replay, and replay after Controller restart. Business and Trace topology
   gates must pass; the independent off-host export acceptance remains
   separate.

The normal recovery Docker path uses
`make e2e-stage4-skill-legacy-recovery-trace` to require complete Jaeger
parentage from the Controller request through the Temporal Workflow, RC
Disable, closed-Egress recheck, and publication SQL. Only the previously
reviewed clock-skew warning format is accepted. The separate SIGKILL path uses
`make e2e-stage4-skill-legacy-migration` to test lost Controller receipts and
restart replay; it preserves raw Trace evidence but does not claim complete
parentage across an abnormal process exit.
