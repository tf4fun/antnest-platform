# Interrupted Update acceptance migration

Date: 2026-09-21. Normal-restart migration and regression complete, following
Runtime Controller development synchronization. Strict failures remain recorded.
This batch changes acceptance assets only.

The [migration contract](../tests/e2e/lifecycle-closeout/interrupted-migration-contract.md)
maps the former readiness-gated crash checkpoint to the current committed Update
response boundary. Resource provisioning and Runtime readiness are independent;
the old gate cannot hold the current mutation open. The normal-restart entry
point uses current Foundation deployment/catalog, a private HTTP response
fixture, real service journals and actual Temporal recovery. Historical forced
crash assets remain separate and are not claimed as migrated normal acceptance.

New tests first reject the missing receipt checkpoint and proxy implementation.
Real HTTP coverage verifies exact selection, original body/idempotency/trace
forwarding, no secret retention, completed-only receipt, single hold, cancellation
and identical retry. Trace fixtures require real Workflow shutdown/return parents,
durable Activity ancestry, identical child receipts and the canceled caller.
Initial synthetic trace construction failures (cached parent map, absent Run ID
and non-wire client IDs/status) were corrected in the fixtures; the original logs
are retained. No production span was fabricated or rewritten.

Private logs and independent retained-environment checks live under
`artifacts/verification/lifecycle-interrupted-migration-20260921/`. Raw disposable evidence is
under `artifacts/verification/lifecycle-interrupted/<project>/`.

The first shared regression passes 969 checks with five gated skips (974 total).
Project `antnest-lifecycle-de3be44c` passes all three business operations, exact
replay, two exit-zero Controller stops and exact terminal child/target reuse.
Create and Delete topologies pass. Its first Rebuild oracle fails because the new
acceptance code expected `rpc.method=update_runtime` and `antnest.operation.id`;
the current Runtime client actually emits `update` and
`antnest.operation.request_id`. Source inspection and the original raw client
spans establish those exact fields. A failing contract regression precedes the
oracle correction. Rechecking the unchanged raw trace then passes all ancestry,
both Workflow parents, both Update attempts and committed-response checks; two
real cancellation errors and strict timing warnings remain failed. The original
failed result remains preserved.

## Current interrupted-update result

The corrected full shared regression again passes 969 checks, with five gated
skips and no failures. Fresh project `antnest-lifecycle-b7f62ba5` passes Create,
Rebuild and Delete plus exact-request replay. Both Controllers exit zero and
restart in their original containers, Runtime Controller first. The original
Runtime is physically replaced by the admitted Update; recovery reuses that
exact target, generation, digest, process start time and workspace. The terminal
selected child journal fields, including its attempt, remain unchanged.

There are exactly two generation claims and two execution publications across
Create/Rebuild, one updated observation and one matching rebuilt public event.
The original sentinel bytes/configuration survive. Delete removes the Runtime
and workspace before teardown. The fixture's first receipt is lost by caller
cancellation; the second is delivered with identical request/response hashes,
child request and target revision. No timeout is accepted as the requested fault.

All three current topologies pass. Rebuild contains the real worker_shutdown and
workflow_return parents, the canceled Update Activity and its completed retry,
both successful Runtime SERVER spans, a committed source journal read and final
phase write. Terminal retry performs no Docker call. Three Docker 404 probes
are expected absence with zero probe errors. Two original caller/Activity error
spans remain strict failures, as do timing warnings; all three strict results
fail and the profile retains exit 2.

Ordinary Foundation project `antnest-lifecycle-9434f228` passes nine operations,
two real Tool Runs, two deliberate denials and all sixteen topologies. Eleven
strict failures retain timing, denial and normal drain-interruption errors.
No ordinary Foundation behavior or acceptance exception was changed.

Coverage review then adds the old scenario's explicit new Template revision.
The second run above intentionally used the existing revision to establish the
receipt boundary; it is not evidence of a changed target configuration. A new
failing test precedes the target-revision assertion, and all 29 affected tests
pass after implementation. The final full interrupted-update run must prove
that revision creation leaves the existing Agent unchanged and explicit Rebuild
publishes revision two with its changed request budget, original remaining
configuration and retained workspace.

## Final target-revision run and cleanup

Project `antnest-lifecycle-8b6aab4e` passes the complete revised scenario. Creating
Template revision two leaves the Agent at revision one. Rebuild selects revision
two, changes the request budget from eight to nine, and keeps all other published
configuration fields unchanged. Recovery preserves the target Runtime/process
and original workspace; exact replay creates no additional effects. All three
topologies pass with both actual Workflow parents, two retained cancellation
errors and zero missing-parent edges or Runtime Controller errors. All three
strict results remain failed.

Together with the ordinary Foundation run, the final scenario and shared
integration evidence cover nineteen complete topologies. Fourteen strict
results remain failed: three interrupted-update and eleven Foundation. The
Foundation's seven error markers belong to its two deliberate denials and
normal drain interruption; the new profile's two belong to the canceled Update
caller/Activity. No unrelated error or missing parent is accepted.

Independent checks verify all four projects have no owned containers, networks
or volumes and no verification child processes remain. All twelve retained
development containers preserve their exact IDs, images, start times, restart
counts, mounts, network membership, running and health states; eleven health
checks pass. No development service, production implementation, SDK, clock or
export configuration changed. No historical asset was retired; changes remain
uncommitted.
Final JavaScript formatting, diff whitespace and 159 local document links pass;
private evidence permissions are verified.

The next delivery batch is older Workspace acceptance migration. Abrupt death
before Runtime mutation completion remains explicitly separate from this normal
committed-response recovery contract; its historical evidence and existing
service recovery tests have not been replaced or claimed as revalidated here.
