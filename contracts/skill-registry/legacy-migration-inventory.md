# Legacy system-Skill inventory boundary (B0)

This read-only Runtime Controller boundary supports the explicit legacy migration
decision in the [Skill Registry design](../../docs/skill-registry-minimal-design.md#91-共享卷迁移不能默认为空).
It does not approve a target collection, mutate an Agent, publish a Skill, or
remove the old shared volume. Agent Controller owns each Agent's migration state
and the later explicit administrator choice.

`GET /internal/legacy-system-skills/inventory` returns `200` with:

```json
{
  "volume_name": "antnest-system-skills",
  "inventory_digest": "sha256:...",
  "entries": [{
    "path": "code-review/SKILL.md",
    "kind": "regular",
    "mode": 292,
    "size": 123,
    "digest": "sha256:..."
  }],
  "references": [{
    "container_id": "...",
    "agent_id": "agent_...",
    "running": true,
    "managed": true
  }]
}
```

The inventory includes every directory, regular file, symlink, and unsupported
entry beneath the mounted volume root, sorted by relative path. It never
follows symlinks or returns file bytes or symlink targets. `digest` is the
regular file's SHA-256, or the SHA-256 of the symlink target **text** for a
symlink; directories and unsupported entries have no digest. `inventory_digest`
is SHA-256 of the canonical ordered entries, excluding volatile container
references. `mode` is the permission bits, and `size` is the regular file byte
length (zero for other kinds). An empty array proves only that one bounded scan
saw no entries, not that a pre-cutover Agent had no Skill.

References list all Docker containers currently mounting the configured volume,
including stopped and foreign containers. A managed reference has the RC scope
and Runtime labels; only then may `agent_id` be populated from its label. Any
foreign reference blocks automatic cleanup. If the volume is absent, the scan
changes during traversal, or the bounded inventory cannot finish, the endpoint
fails closed with a retryable dependency error; it never returns a partial
inventory. The scan allows at most 10,000 entries and 1 GiB of regular file
bytes. It is an observation, not a transactional snapshot: the migration
operator must quiesce writers, make the RC-local backup, export it to protected
storage, and compare the digest to a second scan before recording a per-Agent
choice. Controller verifies the RC receipt when recording that choice and keeps
its legacy migration gate closed until protected export and the selected target
are verified and ACP has been explicitly re-admitted.
