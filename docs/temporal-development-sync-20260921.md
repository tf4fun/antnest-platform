# Temporal readiness development synchronization

Date: 2026-09-21. Source baseline: `866d0aa` plus the uncommitted network,
shutdown and [Temporal readiness repair](temporal-readiness-revalidation.md).
The verified readiness candidate is deployed to retained project
`antnest-dev-20260915`; deployment/data checks, normal restart and retained
business/Trace topology checks pass. Five strict timing failures remain. This
delivery does not change application implementation or
SDK versions, retire old assets, or relax strict Trace validation.

## Scope and preservation contract

Deploy Temporal image
`sha256:c2621d785f7a46e39ad148775870407f561e1b6bf4000b89b3af9ca0b2b0c82d`
and synchronize Controller's direct Temporal health dependency. Keep the existing
Controller image and its opt-in Jaeger metrics overlay. Stop Controller before
Temporal with SIGTERM and require exit zero. Start Temporal to actual readiness
before starting Controller; no business mutation retry or timeout increase.

Retain the original Agent Runtime process, workspace volume/files, execution
binding and configuration. Preserve all original ACP rows: 21 Sessions, 43 Runs,
580 messages and 29 Tool attempts. Baseline has no active Runs or lifecycle
operations. Ten other containers must retain IDs, images, start times, restart
counts, mounts and network membership. Credentials and raw evidence stay private.

Save both previous service images under
`antnest/temporal:pre-temporal-sync-20260921` and
`antnest/agent-controller:pre-temporal-sync-20260921`. Export Temporal,
Temporal visibility, Controller and ACP databases and verify archive listings.
Temporal and Controller are stopped for their backups; ACP remains online and
idle, so its logical dump is database-scoped, not a whole-platform offline
recovery set. No database restore or schema change is part of deployment.

## Verification

Deployment completed with both old services exiting zero and all four database
archives verified. The first post-deployment check preserves every original ACP
row and workspace file digest, the original Runtime process, and all ten
unaffected container identities/start times/restart counts. The new Temporal
image, probe and both services' environment match the inspected Compose config.

The first restart driver failed before starting Temporal: `compose start` tried
to traverse the missing `temporal-databases` initializer through `temporal-schema`.
This retained environment had already removed successful one-shot containers.
Both stopped services exited zero; this was a driver dependency assumption, not
a Temporal health failure. Original failure logs remain. The driver now starts
the named existing Temporal container, waits for its actual health, then starts
the named existing Controller and waits for health. No initializer is recreated.
The environment was recovered in that order before rerunning the full check.

The corrected full restart passes: both services exit zero, retain their exact
container IDs, start new processes, and become healthy in the required order.

The first retained replay driver passed raw database payloads into an oracle
intended for decoded public audit events. Its exact-history assertion failed
because `argumentsJson`, `rawOutputJson` and `fileJson` had not been decoded, and
file diffs were not projected. The original failure is retained. The corrected
driver decodes the stored JSON fields, independently checks every saved file diff
and location, and compares all remaining history in exact order through the
existing replay oracle. Service code and raw messages remain unchanged.

The same retained Session loads through the current ACP v1 SDK: 71 durable rows,
69 notifications, exact visible history including the existing rejected Tool
input and saved file changes. No new Run, Tool or message is created. Its actual
`session/load` topology and strict check pass with zero errors/warnings, proving
no model or Runtime call during history restoration.

The temporary-Agent regression passes Create, Disable, Enable, physical Rebuild
and Delete. Its workspace bytes survive Disable/Enable and Rebuild; Delete
removes its Runtime and workspace. Three independent publication traces after
the latest Controller start contain the source SELECT, ACP exchange and actual
acknowledgement UPDATE. All five lifecycle topologies pass, including four
expected Docker absence probes with zero probe ERROR spans.

All nine retained Trace topologies pass (five lifecycle, three publication, one
Session load), with zero missing parent edges or ERROR spans. The five lifecycle
traces retain strict timing failures; publication and replay checks pass strict
validation. Original failure evidence and raw warnings remain unmodified. The
earlier candidate batch's 936 local tests and 28 isolated topologies remain
separate evidence; no application code changed in this deployment batch.

Final full-row comparison preserves all 21 Sessions, 43 Runs, 580 messages and
29 Tool attempts, with zero active Runs. The retained Agent stays ready/idle with
identical configuration and execution binding, Runtime process and workspace
file digest. All twelve development containers run; all eleven configured health
checks pass (Jaeger has no healthcheck). Only Temporal's container/image changed;
Controller retained its original container and image through normal restarts,
and the other ten processes retain their original IDs and start times.

The Controller dependency is verified in resolved Compose configuration. An
initial final-check assertion expected it in the container's dependency label;
`--no-deps` leaves that label empty, so it is not evidence of source ordering.
The resolved configuration and the observed Temporal-before-Controller startup
are checked instead. No additional recreation was needed to alter bookkeeping.

Temporary Agent containers/volumes/networks and verification children are absent.
Backups and rollback images are retained. Development synchronization is complete
at the scoped business/topology level; strict timing acceptance remains failed.
The next migration is Health / Runtime observation, followed by restore, loss,
interrupted-update and older Workspace consumers. Old shared assets stay intact.

Private snapshots, backups and bounded verification drivers are under
`.cache/temporal-sync-20260921/`; ignored artifacts are not guaranteed in a fresh
clone and must not be published.
