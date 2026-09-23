# Runtime Controller development synchronization

Date: 2026-09-21. Deployment, preservation and scoped business/topology checks
pass; six strict timing failures remain. This deploys the validated
[Inspect absence candidate](runtime-inspect-absence-revalidation.md) to retained
project `antnest-dev-20260915` without service implementation changes.

## Preservation and verification contract

Promote candidate image
`sha256:4612f0bcd3bc86a95bd5b71f0de2c5fb509c9ffce819ef67a49d38bbf26137e0`
to `antnest/runtime-controller:local`, preserving the previous image under
`antnest/runtime-controller:pre-runtime-sync-20260921`. Snapshot resolved Compose
configuration and current container state; compare the Runtime Controller
environment before replacement. Require idle business state, normal exit-zero
stops, verified database archives and an unchanged original Runtime/workspace.
No schema changes or restore are planned.

Replace only Runtime Controller using the existing Compose development overlays
and no dependency recreation. Verify candidate health and an additional normal
restart. Eleven other containers must retain identity, image, start time, restart
count, mounts and networks. Original ACP full-row digests and the retained Agent's
configuration/execution binding must remain unchanged.

Use a temporary Agent for Create, Disable, Enable, normal Runtime removal,
source-missing Rebuild and Delete. Check offline observation before explicit
recovery, preserved workspace bytes, source-generation/allocation trace proof,
and HTTP 404 with absent outcome and no ERROR. Verify exact retained Session
replay without new Runs/Tools, and current publication traces. Preserve strict
timing/error failures. Clean only temporary resources and verification children.

Prior service gates and 36 disposable candidate topologies remain separate
evidence. Private baselines, backups, drivers and raw traces are under
`artifacts/verification/runtime-sync-20260921/`; do not publish ignored artifacts.

## Deployment and preservation results

The candidate is deployed and promoted to `:local`. The previous image
`sha256:d994b5e92363cb630ae9b6bc3d64bc8deee64fc93bfd26cf257e54d10f6b1c3d`
remains under the rollback tag above. Resolved Compose configuration and deployed
environment match; only Runtime Controller was recreated. Both its old process
and the candidate's additional normal stop exited zero. The candidate restarted
in the same container and became healthy with a new process start time.

Runtime Controller, Agent Controller and ACP database archives have verified
archive listings and recorded digests. Runtime Controller was stopped for its
own dump; the other databases were backed up online while business was idle.
These are database-scoped rollback assets, not a whole-platform offline restore
set. No schema migration or data restore was introduced by this batch.

Immediately after deployment and again after all regressions, full-row digests
preserve all 21 Sessions, 43 Runs, 580 messages and 29 Tool attempts, with zero
active Runs. Original Agent configuration/execution binding and ready/idle state
are unchanged. Its Runtime container/process and workspace file digest are
unchanged. All eleven unaffected containers retain IDs, images, start times,
restart counts, mounts and network membership. All twelve containers run and
all eleven configured health checks pass; Jaeger has no container health check.

## Retained deployment regression

The original Session loads through the current ACP v1 SDK with exact visible
history: 71 durable messages, 69 notifications, including saved file changes.
Loading creates no Run, Tool or message and makes no model/Runtime call. Its
actual request topology passes with zero ERROR spans; timing warnings retain
the failed strict result.

Temporary Agent `agent_0158a25709f4147a081b40ce1b657ea5` passes Create, Disable,
Enable, source-missing Rebuild and Delete. After Enable, only this temporary
Runtime is normally stopped (exit zero, no OOM) and removed without force.
Controller first observes runtime_exited, then absent; public state is offline
with no executable binding. Explicit Rebuild preserves configuration/workspace
bytes and creates the replacement process. Delete removes Runtime and workspace.

All five lifecycle topologies pass. Five expected absence probes retain HTTP
404 with no probe errors. The repaired source Inspect is one of them: it has
outcome absent, no ERROR status, the exact old generation and Update command
parent, followed by next-generation allocation/start in that same command.
Three independent publication traces after the candidate's latest restart pass
source SELECT, ACP exchange and actual acknowledgement UPDATE checks.

All nine scoped topologies pass with zero missing parent edges and zero ERROR
spans. Six strict results remain failed: five lifecycle timing checks and the
Session load timing check. All three publication traces pass strict validation.
No clock/export tuning or validation relaxation was applied. Business/topology
success is not full strict deployment acceptance.

Independent final checks confirm no temporary Agent containers, volumes or
networks and no verification children. Backups and rollback images remain.
Diff whitespace and 140 local document links pass; private artifact permissions
are verified. This deployment batch adds no service code, so its earlier service
and disposable integration gates were not rerun.
Development synchronization is complete at the scoped business/topology level.
Changes remain uncommitted and no old asset was retired. Next is the remaining
interrupted-update acceptance migration, followed by older Workspace consumers.

The subsequent [interrupted-update migration](lifecycle-interrupted-revalidation.md)
now passes normal committed-response recovery and the selected new Template
revision. Older Workspace migration is next; historical abrupt-crash evidence
retains its separate scope.
