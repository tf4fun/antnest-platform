# Offline restore contract

This document defines what the offline backup and restore profile
(`make e2e-lifecycle-restore`) must prove. The operator procedure it exercises is
described in [Docker backup and restore](../../../docs/docker-backup-restore.md).
The profile uses the Foundation setup, private Temporal, reserved network ranges
and an immutable Runtime image, and exercises Create, Disable, Enable and Delete
with exact replay.

## Private consumer delivery

Deliver the default Restore consumer first, then Skill-restore, and finally run
the independent Skill storage restore suite. Each business profile uses fresh
candidate images and retains sixteen raw services, the fifteen-service
Foundation projection and nine application images.

Preserve the original member login Session and Principal and the creating
administrator's organization. After restoring storage, perform the original
second login, require the same Principal and use that new Session for subsequent
delegation. Private v1 ACP uses only the existing gateway-identity and
agent-ui-acp grants. Each private opener initializes once; retired Gateway ACP
routes are not positive entry points. This migration adds no state/watch call.

| Profile       | Connections / initialize | Business requests | Runs / Provider / Tool           | Completed lifecycle admissions     |
| ------------- | ------------------------ | ----------------- | -------------------------------- | ---------------------------------- |
| Restore       | 2 / 2                    | 6                 | 2 / 4 / 2 (Bash, read)           | 4: Create, Disable, Enable, Delete |
| Skill-restore | 4 / 4                    | 10                | 4 / 8 / 4 (one Bash, three read) | 9                                  |

The default first connection performs `new -> new untouched -> prompt-before ->
load`; the second performs `load original -> prompt untouched`. The untouched
Session must not be loaded or resumed before its first post-restore Prompt.
Skill-restore adds `new -> prompt` for the restored peer and then for the
unaffected original Agent. Collect all eight or fourteen requests, including
initialize, using their actual private CLIENT, upgrade, wire request ID and
Session. Bind each Run audit to its original request, two Provider phases and
one real Tool. Save the pre-restore model inventory before its process is
recreated; the final inventory combines both sides of recovery.

Join all pre-restore ACP connections before stopping writers. Jaeger, the private
relay and the host telemetry receiver may remain running across storage
replacement. Reusing the host access requires unchanged receiver/relay identity
and endpoint evidence; if either is recreated, inspect its new endpoints before
opening new access. Every connection and host exporter must close and join before
its receiver is removed. Independent request and lifecycle collection continues
after a sibling failure unless the parent aborts. Preserve original business,
cancellation, archive and cleanup errors together, including temporary-directory
cleanup failures. Raw identity, wire and error bodies remain in private evidence.

## Recovery set

The recovery set contains five application databases plus Temporal history and
visibility, two owned persistent volumes and three saved encryption keys.

Skill-restore retains eight databases, both workspaces, the complete database-
derived current/lifecycle/set Skill-volume collection and the same three keys.
Do not reduce this collection to currently mounted volumes. The independent
`make e2e-stage4-skill-storage-restore` suite separately proves eight databases
and five volumes (two workspaces, ready, ready-empty and candidate), with no ACP
requests or Runs; neither business profile replaces that storage evidence.

The independent target builds fresh Runtime and application candidates, verifies
the original fifteen-service deployment and nine application image IDs, and
opens no private ACP connection. Its five fixture volumes are project-scoped;
reject an existing name or foreign ownership before writing any fixture bytes.
Keep the before/after database-derived recovery plans, fingerprints, saved-key
digests and original/replacement PostgreSQL identities in private evidence.
Preserve partial evidence and every original failure, including startup before
configuration returns. Remove recovery inputs only after owned Docker cleanup
succeeds; a cleanup or archive failure cannot produce passing admission.

## Required behavior

- Application writers stop normally, then Temporal, and the complete clean-exit
  inventory is required before export.
- Empty storage and the original roles are recreated, and all seven databases are
  restored (all eight for Skill-restore) before any schema initializer or writer starts. Frozen data, sequence,
  ownership and ACL fingerprints must match.
- Permission-drift probes, archive checksums, volume ownership, hidden files,
  modes, symlinks and Skills are preserved.
- The isolated in-memory Jaeger keeps running across storage replacement so both
  sides of recovery stay traceable; it is not recovery data. The deterministic
  model is stopped and recreated so post-restore requests start empty.
- Public Agent events, configuration, network rules and the original completed
  Run are unchanged. Exact history replay must not create a Run or call the
  model.
- Prompting an untouched restored Session exercises its original encrypted MCP
  revision and exactly one new Tool Run under the new execution revision.
- A business Delete removes the owned Agent resources.
- Skill-restore closes Registry after restoring storage, then enables both
  Agents with their own preserved Skill volumes and pinned v1 contents. Removing
  the peer's Skill volume must leave its original Enable request in same-key
  `retry_wait/skill_preparation_unavailable`, with the Agent disabled, no Runtime
  and no automatically created empty Skill volume. Preserve the original timeout
  or HTTP 503 receipt; it is not a tenth completed lifecycle admission. The
  unaffected original Agent must still complete a real read before both Deletes
  remove all owned volumes.

## Trace and verification rules

Actual SDK request Traces and all lifecycle topologies retain their original
strict diagnostics separately from business admission. Both profiles have no
ACP semantic rejection, so no Loss-unavailable or Managed-busy exception applies.
Only existing reviewed completed Runtime cleanup and lifecycle/clock policies
apply; missing, foreign, duplicated or unclaimed internal diagnostics fail.
Confirmed external SDK issues remain non-blocking without new SDK investigation
or workaround. Negative assertions come first, checks run serially, and owned
cleanup and other containers' identity, image, mounts and health are inspected
afterwards.
