# Stage 3 Base E2E

This suite runs the Stage 3 stack end to end through Console, Gateway, ACP and
Runtime. It asserts:

- Console creates a Provider connection, then stable Models and Templates.
  Credentials rotate on the Provider; Model edits require `expected_version`
  and preserve the API model name. Template history and an Agent's build
  snapshot remain immutable until Rebuild.
- Model write parameters exclude the Provider endpoint present in Model reads.
  Template publication rejects malformed image references, but preserves valid
  tags without resolving local image availability. The executing fixture uses
  the configured immutable image; a second unexecuted Template proves valid
  missing-tag preservation. Runtime image-resolution failures are covered by
  the lifecycle fault suites.
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

Skill lifecycle checks use frozen Template versions and prepared read-only
Skill sets.

Identity/OIDC, Managed MCP and fault profiles run through their own launchers.
`ANTNEST_E2E_KEEP_STACK=true` is rejected before any dependency starts; unset,
empty or `false` keeps the stack disposable. This driver verifies Workspace
HTML, bootstrap and protocol behavior; browser interaction is covered by the
[workspace browser profile](../workspace-closeout/README.md#browser-profile).

Raw lifecycle diagnostics, when collected, stay in the ignored private
`artifacts/verification/stage3-base/<project>/stage3-traces/` directory. Only aggregate business,
topology, warning and cleanup evidence is printed.
