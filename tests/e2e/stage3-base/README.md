# Current Stage 3 base acceptance

This integration fixture owns no production service changes. Its contract is:

- Console creates a Provider connection, then stable Models and Templates.
  Credentials rotate on the Provider; Model edits require `expected_version`
  and preserve the API model name. Template history and an Agent's build
  snapshot remain immutable until Rebuild.
- Model write parameters exclude the Provider endpoint present in Model reads.
  Template publication rejects malformed image references, but preserves valid
  tags without resolving local image availability. The executing fixture uses
  the configured immutable image; a second unexecuted Template proves valid
  missing-tag preservation. Runtime image-resolution failures remain part of
  the later lifecycle fault batch.
- Fresh resource IDs at Gateway/ACP boundaries follow the
  [platform generation contract](../../../contracts/resource-identifiers.md):
  Identity, catalog, Agent, lifecycle events, Runtime revisions and Sessions.
  Catalog retries retain IDs and history/rebuild retain Session references;
  external model response and Tool-call identifiers remain protocol-owned.
- Password/directory/SCIM administration, idempotent catalog creation,
  pagination, image rejection, scoped Agent lookup and events remain covered.
- Create, Disable, Enable, Rebuild and Delete complete through Temporal and
  current Runtime operations. Drain requires published execution configuration
  and ACP settlement before Runtime mutation.
- Official SDK v1 WebSocket, v2 WebSocket and v1 HTTP exercise real Bash effects
  and exact history recovery without model re-execution. Rebuild preserves the
  workspace. Logout rejects new work on both WebSocket versions.
- Trace collection uses actual Gateway lifecycle response IDs and actual SDK
  message IDs, with RPC content capture disabled. Warnings fail the strict
  gate even when business, topology and privacy checks pass. Docker absence
  probes must have the exact owner, command ancestry and subsequent successful
  allocation/start or storage verification to permit topology diagnosis; their
  ERROR spans still fail the strict gate. Other errors fail immediately.

`make test-stage3-base-fixtures` runs local gates. `make e2e-stage3-local`
uses already built local images; `make e2e-stage3` builds first. Both default
to an isolated, bounded, disposable project. Existing development containers,
volumes, credentials and ports are outside its ownership.

`make e2e-stage4-skill-ready-loss` uses the Skill delivery profile and deletes
only the disposable Agent's labeled system Skill volume after Disable. The
same frozen collection must reappear with the next materialization before
Enable completes. The trace gate requires the missing-volume probe to belong
to RC Prepare and the queued admission to be followed by success. Build the
current Runtime Controller image before this local E2E target.

`make e2e-stage4-skill-ready-drift` changes only the disposable disabled
Agent's `SKILL.md` in its labeled volume. Enable must discard that physical
materialization and restore the frozen collection from Registry under the next
materialization. The Trace gate permits only the expected cleanup preparation
retries and the reviewed clock warning exception.

`make e2e-stage4-skill-target-drift` prepares a changed Template collection
while the source Runtime remains active, corrupts only the unmounted target
manifest, and replays RC Prepare. It requires cleanup and rematerialization
from `m1` to `m2` with the source still available before Controller admits
Rebuild. The normal ACP Run then reads the new frozen Skill and the Agent is
deleted with no owned Runtime resources left.

`make e2e-stage4-skill-registry-outage` stops only this project's Registry
before admitting a Rebuild to a changed Template. It checks the durable
preparation retry while the source Agent completes a real ACP Run using its
existing Skill, then restores Registry and completes the same Rebuild intent.
The follow-up Run reads the new version. The Trace gate requires a
`retry_wait` activity followed by successful admission in the same Workflow;
the project and owned Runtime resources are removed afterward.

`make e2e-stage4-skill-offline-reuse` stops this project's Registry after the
Agent has frozen Skill v1 and the Template has advanced to v2. Disable,
Enable and an explicit Rebuild to the original Template revision must complete
while Registry is offline. A real ACP Run reads v1 after that Rebuild. The
Docker-side gate also compares the exact labeled Skill volume before and after
the offline lifecycle operations while Registry is still stopped. The
Registry is then restored so a changed-Template Rebuild and v2 Run complete.
All six lifecycle Trace topologies and owned-resource deletion are checked.

`make e2e-stage4-skill-fenced-invalidation` prepares a changed Template Skill
set, holds the disposable Rebuild Update request after Fence, and deletes only
the unmounted target Skill volume before forwarding that request. It checks
that the real ACP consumer closes admission during Drain, that RC rejects the
invalidated set, and that Controller restores the source Runtime and ACP
admission before a fresh Rebuild succeeds. The one-shot test proxy and its
network attachment are removed with the disposable project.

`make e2e-stage4-skill-restart-rebuild` holds RC Update after Fence, then
gracefully restarts both Agent Controller and Runtime Controller while ACP
admission stays closed. The held request is released only after both services
are healthy. The original Rebuild must resume using the prepared Skill set,
complete one target Runtime, and support a real ACP Run reading the new Skill;
Delete must remove owned resources. Trace validation accepts only the canceled
pre-forward RPC and Activity caused by the deliberate Controller restart, plus
the separately reviewed clock warnings. The test does not wait five wall-clock
minutes; RC's older-than-Drain reference is covered by its PostgreSQL component
test.

`make e2e-stage4-skill-mount-race` runs a separate disposable Skill delivery
project through a real ACP Run, then arms a one-shot Docker socket proxy before
Rebuild to a changed Template. The proxy deletes only that Agent's prepared,
unmounted target Skill volume after RC preflight and just before forwarding
ContainerCreate. Docker recreates the same name as an unlabeled empty volume;
the post-create gate must reject it, remove the unstarted candidate, retain RC
`unknown`, and keep Controller in `runtime_update` with ACP admission closed.
Controller's replay of the same accepted RC request must then encounter the
unlabeled volume as `storage_ownership_conflict` while RC remains `unknown`.
The test removes only the now-unreferenced, unlabeled injected volume after
checking its exact receipt. Build the current Runtime Controller image before
running this profile. This covers the Fence-after first-create race and its
accepted replay. `make e2e-stage4-skill-mount-response-loss` repeats the same
race but drops Docker's successful ContainerCreate response after the daemon
has created the candidate. RC must inspect that existing container, reject its
untrusted mount, keep the operation `unknown`, and leave ACP admission closed.
The test-owned cleanup verifies the candidate's exact Agent, scope, mount and
unstarted state before removing it and the injected volume.

`make e2e-stage4-skill-initialize-race` arms the same proxy before the Agent
ID exists. It targets only the first RC-created Runtime with an owned,
read-only prepared Skill mount, deletes that unmounted volume after preflight,
and verifies that first Initialize remains `unknown`, ACP never reports the
Agent ready, and no Runtime candidate survives. The injected unlabeled volume
is removed only after exact receipt and reference checks.

`make e2e-stage4-skill-start-response-loss` keeps the prepared Skill volume
intact, then drops Docker's successful Start response during a changed-Template
Rebuild. RC must inspect the running target and recheck its actual read-only
Skill mount and manifest before reporting completion. The Agent then completes
a real ACP Run that reads the new Skill; the normal Delete removes all owned
Runtime resources. Its Trace gate accepts exactly one scoped Docker Start
transport failure only when creation, recovery inspection and lifecycle
completion are all present. A changed running mount is separately rejected by
the RC service test.

`make e2e-stage4-skill-legacy-inventory` places a nonempty legacy note in the
disposable shared volume and retains a stopped foreign container mounting it.
RC's read-only inventory must report the exact file hash and foreign reference;
the normal Skill delivery business and Trace gates still run afterward.
`make e2e-stage4-skill-legacy-choice` uses a separate disposable project to
verify the RC backup receipt through Controller's choice endpoint. It simulates
the pre-cutover marker on a newly created Agent, checks rejected and accepted
choices, verifies a private destination copy from RC's backup volume, and
confirms Enable remains blocked. The test destination is local: this is not
off-host export evidence and does not perform migration.
`make e2e-stage4-skill-legacy-migration` extends that disposable project through
controlled Enable for a disabled Agent and Rebuild for an enabled Agent. It
checks invalid proof and stale choice rejection, marker resolution and the
read-only managed Skill mount. The enabled Rebuild selects a fixed nonempty
Template revision and confirms its frozen Skill is readable by the Runtime's
unprivileged user. A real ACP SDK Run then asks the model to call Runtime
`read` for that Skill and checks the returned versioned body. Its verifier
runs on the same host, so a real
off-host operator transfer and verification remain separate acceptance work.
The opt-in `make e2e-stage4-skill-post-migration-restart` gate also recreates
Controller and RC after the migration, then verifies ordinary Disable/Enable
and Rebuild to the same frozen Template revision reuse the read-only Skill
volume while the marker remains resolved. Publishing v2 and revising the
Template leave the Agent pinned to v1 until an explicit Rebuild installs v2;
the Runtime body and a new ACP Run verify the new version. After Disable, the
gate removes only that Agent's labeled retained v2 volume, then confirms Enable
rematerializes the fixed collection into a new read-only volume and another ACP
Run reads v2 while the migration marker stays resolved.
The same project revokes the trusted proof key exactly when another migration
reaches Publish: Controller must re-close Egress, fail and quarantine that
operation, leave its marker pending, and require source recovery before a new
request can be admitted.

Identity/OIDC, Managed MCP and fault profiles now dispatch to their separate
migrated launchers. Their old inline copies are superseded. The explicit
`ANTNEST_E2E_KEEP_STACK=true` flag is now [retired](../../../docs/retained-seed-retirement.md)
and rejects before any dependency is invoked. Unset, empty or `false` keeps
current disposable behavior. The [old inline tail](../../../docs/stage3-tail-retirement.md)
and its exclusive CLI/input helpers are now removed. The subsequent
[interruption retirement](../../../docs/interruption-assets-retirement.md) removes
the historical startup-gate/Trace graph; shared current helpers remain.
This driver verifies Workspace HTML/bootstrap and protocol behavior, not a new
browser interaction acceptance. See C4 for the separate browser evidence.

Raw lifecycle diagnostics, when collected, stay in the ignored private
`artifacts/verification/stage3-base/<project>/stage3-traces/` directory. Only aggregate business,
topology, warning and cleanup evidence is printed.
