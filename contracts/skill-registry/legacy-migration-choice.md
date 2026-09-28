# Legacy system-Skill migration choice (Controller boundary)

Agent Controller owns the per-Agent migration marker created for pre-cutover
Agents. Runtime Controller supplies the [read-only shared-volume inventory](legacy-migration-inventory.md).
Recording a choice is **not** migration completion: Enable and ordinary Rebuild
remain blocked until a later, explicit migration operation installs the target
configuration and restores ACP admission. Existing containers are not changed.

`GET /internal/agents/{agent_id}/legacy-system-skills-migration?organization_id=...`
returns a pending legacy marker, its latest choice if any, and the current RC
inventory (`volume_name`, `inventory_digest`, entries, references). A foreign
organization or nonlegacy Agent receives the same `404`. If RC cannot provide a
complete inventory, the endpoint returns `503`; it never substitutes an old
digest or an empty list. Only a system administrator may expose this internal
response in a product surface.

`POST /internal/agents/{agent_id}/legacy-system-skills-migration/choices`
requires `Idempotency-Key`, the Agent's organization and authenticated actor,
the observed inventory digest and volume name, an RC backup reference and
SHA-256 of its manifest, plus exactly one of:

- `empty`: explicit confirmation that this Agent's target collection is empty;
- `template_revision`: an existing revision in the same organization whose
  fixed Skill list is nonempty (`template_id`, `template_revision`).

The Controller reads the live RC inventory again and requires the submitted
identity to match. It then reads RC's verified backup receipt and compares the
reference, volume, inventory digest and manifest digest. Missing or mismatched
receipts return `409 legacy_backup_mismatch`; unavailable verification returns
`503 dependency_unavailable`. It rejects a deleted Agent, in-flight lifecycle
operation, nonlegacy Agent, foreign Template, invalid choice, or changed
inventory. An exact request-ID/body replay returns the same
choice; a conflicting replay returns `409 request_id_conflict`. Different
request IDs append new decisions with a per-Agent sequence, preserving history
and making the latest choice explicit. No choice deletes or rewrites the old
shared volume, historical Agent spec, or migration marker. `state` remains
`pending`; `choice_recorded` is a presentation state only. The current choice
boundary proves only that the RC local archive was readable at choice time. It
does not prove that the archive was exported to protected storage. A later
migration batch must verify that export, perform the chosen lifecycle
transition, verify the new fixed set, and then atomically mark the legacy gate
resolved. Until that batch exists, the choice API cannot reopen admission.
The [migration operation contract](legacy-migration-operation.md) defines that
later transition and its proof checks.
