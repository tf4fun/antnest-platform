# Legacy system-Skill source recovery (Controller C0 contract)

This operation is for a pre-cutover Agent whose migration marker is `pending`
but whose enabled source cannot pass Controller's normal rebuild-source check.
It retires a **proven, still-owned RC Runtime** to a disabled state so the
administrator can later submit a fresh, explicit migration operation. It
does not infer an empty source, re-create an execution binding from a health
observation, install a target Skill set, resolve the marker, or delete the old
shared Skill volume. The separate [proof-loss recovery](legacy-proof-loss-recovery.md)
continues to own a target Runtime left by a failed migration.

`POST /internal/agents/{agent_id}/legacy-system-skills-migration/source-recovery`
requires a trusted administrator, `Idempotency-Key`, `organization_id` and
`actor_principal_id`. An exact request-ID/body replay returns the recorded
operation, while changed bytes with the same ID return `request_id_conflict`.
The organization-scoped operation query returns its receipt after a timeout.
The [closed v1 schema](legacy-source-recovery.schema.json) defines the request
and receipt; no caller-supplied Runtime revision or absence claim is accepted.

## Admission and source identity

Controller admits only an Agent in the caller's organization with a `pending`
legacy marker, a complete frozen Agent spec, desired and activation state
enabled, and no competing lifecycle or recovery operation. The source must
actually fail the normal rebuild-source check; a complete source uses the
regular explicit migration path. `legacy_migration_proof_lost` belongs to the
proof-loss route and is rejected here. Owner revocation remains authoritative;
this route never grants access to a revoked owner.

A Runtime process exit may clear the current executable binding while leaving
the immutable last-successful execution revision intact. If that retained
revision still proves the configured source, this route is inapplicable even
after the container starts again; ordinary lifecycle handling owns that case.
Only a genuinely unprovable stored source can enter this recovery journal.

RC inspection must report the same Agent and **exact Runtime revision stored
on that Agent**, lifecycle `provisioned`, phase `running`, and an observed
process identity. Controller records that inspection, the Agent aggregate
sequence, the administrator, and the Egress attachment identity in a durable
journal before any effect. A missing RC Environment, changed revision,
ambiguous process, foreign ownership, or missing Agent Runtime revision is
`legacy_source_manual_recovery_required`: the operator must restore a
consistent Controller/RC backup or reconcile the source outside this route.
RC or Egress transport uncertainty returns `dependency_unavailable` and leaves
no journal or effect. These checks are repeated under the Agent lock at
admission; later effects compare the journaled identities.

## Durable effect and publication

After admission Controller closes ACP execution admission and waits for
existing Runs to settle under the ordinary bounded lifecycle drain policy.
It then closes the existing Egress attachment with resource-version checks,
keeping the Agent isolated throughout any uncertain outcome. Controller calls
RC Disable with a child request ID derived from the recovery request and the
inspected Runtime revision. RC must accept that exact expected revision and
return a completed disabled result for the same child request; a timeout or
`unknown` effect retries the **same** child
request. This path preserves the workspace, current Skill volume, legacy
shared volume, and immutable history. It never calls RC Delete or Update.

Before publication Controller verifies that Egress is still closed and that
RC's disabled result belongs to the journaled child request. One transaction
then compares the Agent sequence, migration marker and source identities;
records the new disabled Runtime revision; clears the executable binding;
sets desired and activation state to disabled; records an
`agent_legacy_source_recovered` audit event; and completes the recovery
receipt. If the old last-successful execution pointer no longer names a
coherent immutable execution record, the transaction clears only that pointer,
leaving historical rows and audit events untouched. The marker remains
`pending`, with its choice/history unchanged. Ordinary Enable stays blocked;
the administrator must present a current choice and fresh, independently
verified export attestation to the existing controlled migration Enable path.

An unknown drain, network or RC effect leaves the journal `running` and
retries the same stage. Definitive RC rejection, changed network attachment,
or failed publication CAS becomes `manual_recovery_required`; Egress remains
closed and the marker remains pending. No failure converts an unproven source
to an empty Skill set or reopens execution. The journal stores a bounded
reason, not Skill contents, backup bytes or credentials.

## Receipt and acceptance

The receipt states are `running`, `completed`, and
`manual_recovery_required`; phases are `drain`, `network_fence`,
`disable_runtime`, `publish`, and `done`. A completed receipt binds the
observed source Runtime revision and process identity, child request ID,
and disabled Runtime revision. Before admission: foreign organization is
`404 agent_not_found`; active work or changed Agent is `409 lifecycle_conflict`;
an inapplicable source is `409 legacy_source_recovery_not_applicable`;
unattributable RC source is `409 legacy_source_manual_recovery_required`;
inconclusive dependency reads are `503 dependency_unavailable`.

Delivery remains service-owned:

1. **C0 shared contract:** this document and schema freeze the narrow recovery
   boundary. No RC, Egress or ACP wire method is added.
2. **C1 Agent Controller:** test-first journal, admission, drain/fence/Disable,
   replay, publication CAS, HTTP/Temporal route and service documentation.
   RC, Egress and ACP are existing clients; no other service implementation
   changes in this batch.
   The journal, effect stages, publication, HTTP route and Temporal worker are
   implemented with local/component evidence.
3. **C2 integration:** in disposable Docker, make a pre-cutover Agent's
   execution source unprovable while retaining its exact RC Runtime, then
   recover to disabled and complete a fresh-proof controlled Enable. Cover
   active Run drain, wrong/missing RC revision, changed Egress, unknown and
   rejected Disable, Controller restart replay, retained workspace/Skill
   volumes, business admission and applicable Trace topology. A same-host
   test does not prove the protected export is off-host.
   All listed C2 cases pass in disposable Docker via
   `make e2e-stage4-skill-source-recovery`. The Egress drift case proves that
   Controller re-closes an externally reopened attachment before recording
   manual recovery. Independent off-host export acceptance remains separate.
