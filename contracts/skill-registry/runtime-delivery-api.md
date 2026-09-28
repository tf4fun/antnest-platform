# Runtime Controller system-Skill delivery contract (B0)

This contract fixes the Controller → Runtime Controller boundary for immutable
system-Skill collections. B3 preparation, lifecycle consumption, Docker startup
gating, reference transfer and bounded cleanup are implemented in Runtime
Controller; cross-service and restore/migration acceptance remain pending.
Registry owns the versioned ZIP; Runtime Controller
owns preparation, its Docker volume and lifecycle consumption. The old
`skill_instructions` execution-snapshot body channel remains permanently empty.

## Identity and preparation

`POST /internal/runtimes/{agent_id}/skill-sets/prepare` requires
`Idempotency-Key` and this JSON body:

```json
{
  "organization_id": "org_00000000000000000000000000000000",
  "owner_operation_id": "agent-build-123",
  "layout_version": 1,
  "skill_set_digest": "sha256:...",
  "system_skills": [{
    "skill_id": "skill_11111111111111111111111111111111",
    "version": 1,
    "name": "code-review",
    "description": "Review code",
    "artifact_digest": "sha256:...",
    "content_digest": "sha256:...",
    "artifact_size": 100,
    "unpacked_size": 200,
    "package_rules_version": 1
  }]
}
```

RC independently validates every field and recomputes `skill_set_digest`
using the [v1 encoding](../agent-controller/control-api.md#templates) and
[shared fixture](../../tests/integration/skill-registry/skill-set-digest-v1.json).
The preparation key is `(controller_scope, organization_id, agent_id,
skill_set_digest, layout_version)`; it does not contain compute generation.
The request ID is bound to the exact body. A conflicting replay returns
`409 request_id_conflict`. Another request for the same preparation key joins
the existing work but receives its own operation-owned reference.

An accepted request returns `202` and a durable receipt with `request_id`,
`agent_id`, `organization_id`, `owner_operation_id`, `state`, progress
(`verified_packages`, `verified_bytes`, `total_packages`, `total_bytes`) and
`retry_after` where applicable. States are `queued`, `preparing`,
`retry_wait`, `paused`, `ready`, `rejected`, `invalidated`, and
`cleanup_pending`. Once `ready`, the same receipt includes
`prepared_skill_set` (`skill_set_digest`, `layout_version`) and an opaque
`prepared_reference_id`. The reference is persisted atomically with the ready
receipt and has **no TTL**. Replays return the current progress of the same
durable intent; an HTTP deadline does not cancel accepted preparation.

`GET /internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}?organization_id=...`
returns that scoped receipt or `404 preparation_not_found`. `POST` to the same
path with `/release` suffix and `Idempotency-Key` releases that operation's
reference after its lifecycle work has completed or been abandoned. Release
of an already released reference is idempotent. A caller cannot release a
different organization's or operation's reference. The Controller retains
its reference throughout Drain and Egress Fence; RC atomically transfers
protection to the lifecycle record before the Controller releases it.

Transient Registry/network/Docker errors move accepted work to `retry_wait`
with a backoff; exhausted dependency budget moves it to resumable `paused`.
Missing version, digest/size mismatch, malformed ZIP, unsafe path, incompatible
package rules or frozen metadata are deterministic `rejected` results. They
never create a terminal failed Runtime Environment. Queue wait is not counted
against an individual preparation attempt's execution budget. Preparation
never runs inside the 2-minute lifecycle mutation deadline.

## Lifecycle consumption

Initialize, Update and Enable configurations add `organization_id`,
`system_skills`, `prepared_skill_set`, and `prepared_reference_id` for both
empty and nonempty collections. All four enter request and deployment
identity; only the immutable digest/layout enter the logical collection
identity. No physical volume name or materialization number crosses the
service boundary. Disable/Delete use recorded ownership. Enable consumes the
same fixed collection and can reuse its verified volume while Registry is
offline.

For a new lifecycle request, RC first checks existing idempotent replay,
revision and image, then verifies the ready preparation and persistent
reference **before** `BeginTransition`. If invalid, it returns
`409 prepared_skill_set_invalidated`, `retryable=false`, without a lifecycle
receipt or side effect. An accepted operation keeps its original reference on
replay, even if preparation later changes. Controller must not retry this
particular lifecycle request while its source is fenced; it restores source
network/admission and starts a new preparation subrequest.

After Docker creates a Runtime container, and again on every not-yet-started
recovery/adoption path, RC inspects its actual `/skills` volume mount. It
verifies type, name, destination, read-only/NoCopy, owned volume labels,
materialization identity and bounded `.antnest-skills.json` against the ready
record. A mismatch blocks start and returns
`skill_mount_verification_failed` with failed/unknown effect according to
observed side effects. Docker can auto-create an absent named volume, so a
create-before check is not sufficient. RC only removes a candidate container
or auto-created empty volume after proving their exact ownership; uncertain
effects remain isolated for reconciliation.

The volume holds real unpacked files under `/skills/<name>/` plus the
collection manifest (at most 8 MiB, including each Skill name and file inventory).
Before marking a set ready, RC reads back the entire volume root and rejects
missing, changed or extra files and directories. It contains no symlink, hardlink, download pointer,
Registry credentials or executable preparation process. RC uses a never
started Docker preparation container with `NetworkMode=none`, `NoCopy=true`,
archive write/readback and a separate `io.antnest.managed` label so it never
appears as Runtime compute. Full content readback and per-package checkpoints
belong to preparation; lifecycle only performs bounded identity checks.

Delete seals further preparation for the Agent, settles outstanding
references, and cleans only proven owned volumes. A ready record whose volume
is missing is invalidated and must be rematerialized under a new private
physical identity; it is never silently replaced by an empty Docker volume.
