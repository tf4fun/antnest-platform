# Active Runtime Skill-set verification

Runtime Controller owns a private, read-only verification operation for the
Controller's legacy system-Skill migration publish gate:

`POST /internal/runtimes/{agent_id}/skill-sets/verify-active` requires an
`Idempotency-Key` for request correlation. Repeating it performs a fresh
read-only verification; RC does not cache a prior success.

The request supplies `organization_id`, `expected_runtime_revision`,
`prepared_reference_id`, `prepared_skill_set` (`skill_set_digest` and
`layout_version`), and the complete frozen `system_skills` list, including an
explicit empty array. The Controller must use the reference held by the
lifecycle operation; RC checks that it remains ready and unreleased. The
request does not mutate either the Runtime or the Skill set.

RC recomputes the collection digest and resolves the ready
reference. It reads the current Environment and requires the exact expected
Runtime revision in `provisioned` state. It then checks the running Docker
container's Agent, scope, generation and deployment-digest labels, read-only `/skills` mount,
owned volume labels, and manifest bytes and digest. A matching volume name or
historical success receipt alone is insufficient. The check must fail closed
on a missing Runtime, released or invalidated reference, missing volume,
changed mount, or changed manifest.

On success RC returns `agent_id`, `runtime_revision`, `skill_set_digest`,
`layout_version`, `manifest_digest`, and `verified_at`. The Controller may use
this receipt only for the same migration operation, target revision and
prepared collection, and must finish its database publish transaction before
releasing the preparation reference. It must recheck the signing key and
frozen choice in that transaction. A later Runtime change still needs normal
Runtime observation and admission handling; this receipt is not a perpetual
lease on the container.

This private contract is a producer prerequisite for the Controller migration
publish batch. No Agent-facing API is implied.
