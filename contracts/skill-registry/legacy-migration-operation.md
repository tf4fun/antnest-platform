# Legacy system-Skill migration operation (Controller boundary)

The append-only [choice](legacy-migration-choice.md) and independently signed
[protected export](legacy-export-attestation.md) are prerequisites, not a gate
release. Controller owns one explicit, idempotent migration operation per
pre-cutover Agent. Ordinary Enable and Rebuild remain blocked while its marker
is `pending`; no other service writes that marker.

The `POST /internal/agents/{agent_id}/legacy-system-skills-migration/operations`
requires an idempotency key, organization and authenticated administrator,
the latest choice sequence, and the complete v1 attestation. Controller must
check the Agent's pending marker and no conflicting operation, compare the
choice sequence under the Agent lock, re-read the live RC inventory and the
specified RC backup receipt, and verify the proof using a configured key whose
durable history is still active. All identities and the proof expiry are
checked at admission. Request-ID replay returns the original operation;
different bytes with that ID are rejected.

The frozen choice, attestation bytes and digest, signing key ID, and expiry
must be recorded in the same transaction that begins the lifecycle operation.
The pending marker blocks an ordinary rebuild at the repository boundary;
replay must compare the bound proof exactly. A new choice cannot be appended
while that operation is active. This binding does not resolve the marker.

For `template_revision`, the chosen immutable Template revision supplies both
model and fixed system-Skill versions. For `empty`, Controller preserves the
Agent's frozen source configuration and explicitly prepares an empty system
Skill set in a dedicated prepared volume with an actual collection digest; it
must never mount the old shared volume or interpret an unreadable old volume
as empty. Both
paths prepare the target set before any Drain, Network Ensure or Egress Fence.
An enabled Agent with a proven executable source follows the rebuild phases
and source-preserving rollback. A disabled Agent follows a distinct controlled
Enable path and keeps its network attachment closed until RC verifies the target
Runtime's actual Skill mount. It cannot be routed through ordinary Enable while
the marker is pending. An enabled Agent with an unproven or missing source gets
`legacy_migration_recovery_required` before preparation or lifecycle admission;
the operator must restore or reconcile its executable source before submitting
a valid explicit migration intent. The narrow
[source recovery operation](legacy-source-recovery.md) can retire an exact,
still-owned RC Runtime to disabled without releasing the migration gate;
missing or mismatched RC sources still require operator restoration. No empty source is inferred. The migration
identity must be distinct so ordinary Rebuild and Enable cannot bypass the
legacy gate. A proven source Runtime stays available during preparation. If
the target update is rejected, Controller restores the proven source network
where applicable and leaves the marker pending.

If the bound proof expires, its signing key is revoked, or its choice/marker
ceases to be current after a lifecycle effect, publish stops. Controller
re-closes the target network attachment before recording a terminal,
unavailable Agent state; the migration marker remains `pending`. The same
expired proof must not be retried indefinitely or used to publish the target.
An operator must reconcile the actual Runtime and source before submitting a
new proof and migration operation. Transient database and RC verification
failures remain retryable and do not masquerade as proof loss.
The [proof-loss recovery operation](legacy-proof-loss-recovery.md)
defines a bounded route for a target Runtime whose identity still matches the
failed migration. The separate [source recovery operation](legacy-source-recovery.md)
retires an unprovable pre-cutover source only when RC still proves its exact
Runtime revision; absent or mismatched RC sources remain an operator procedure.

At publish, Controller must use RC's
[active Skill-set verification](active-skill-set-verification.md) for the
actual target Runtime revision and prepared set identity, then verify the
operation's frozen choice and proof, and the active
signing key again. It atomically publishes the new Agent configuration and
marks the marker `resolved`, storing an evidence reference tied to the
operation, choice and protected export. Only that commit may restore ordinary
admission. A later key revocation cannot rewrite historical evidence, but a
revocation before publish prevents resolution. The old shared volume remains
in the recovery set until all references and migration records are reconciled;
this operation never deletes it.

The enabled-Agent rebuild and disabled-Agent controlled Enable now share the
distinct migration request identity, choice/backup/signature preflight and
target preparation before their lifecycle transitions. The repository binds
the proof, latest choice and target spec atomically with each transition.
Disabled Enable verifies the active mount before opening the network. Both
paths verify again at publish, atomically publish the target and resolve the
marker with the operation request ID as evidence reference. A missing or
mismatched verification receipt rolls back both changes. Unproven sources now
receive an explicit recovery-required response without changing the Agent or
marker. Both paths pass a disposable cross-service Docker check, including
a fixed nonempty Template Skill read through a real ACP Run on the target
Runtime, rejected invalid proofs and stale choices, and a proof-key revocation
at Publish that re-closes Egress and keeps the marker pending. The separate
source-recovery C2 Docker gate now passes, but neither local gate establishes
an off-host export. Independent operator verification outside the RC failure
domain is still required before the protected-export acceptance is complete.
