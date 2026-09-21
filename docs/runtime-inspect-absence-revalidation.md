# Runtime source Inspect absence repair

Date: 2026-09-21. Baseline: `866d0aa` plus preceding uncommitted acceptance,
Temporal readiness and synchronization batches. This follows the two source
Inspect 404 ERROR spans retained by [Loss acceptance](lifecycle-loss-revalidation.md).

## Runtime Controller batch

The [service contract](../services/runtime-controller/docs/inspect-absence-contract.md)
was defined before tests and implementation. Driver.Inspect already returns a
successful absent Inspection when its container GET receives 404. The repair
marks only that GET with the existing expected-absence context. HTTP status 404
and the domain result remain unchanged; telemetry uses unset span status,
outcome absent and no error event. Generic client lookups, required resources,
post-create checks, other HTTP failures and transport/body failures retain their
existing behavior. No retry, timeout, lifecycle or clock/export change.

Real HTTP regression first reproduced the erroneous ERROR and covers missing
source, forbidden, server failure and a generic client 404. The new cases share
the existing recorder lifecycle because the package's global tracer caches its
provider; an initial independent recorder failed only in the full package run.
That failed run is preserved. Docker/telemetry race regression then passes.
Full service race validation passes twelve packages, 204 tests and 177 subtests,
with no failures or skips, using an independent PostgreSQL database and real
Docker image/reference integration. Its database project
`antnest-inspect-tests-74606` is removed. Golangci-lint reports zero issues and
service formatting passes.

## Integration batch

Use a separately tagged Runtime Controller candidate in disposable Foundation
and Loss deployments. Foundation now supports
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE`, checks the selected image against actual
container deployment evidence, and retains its normal default. Test-first
configuration coverage rejects the previously ignored candidate selection.
Preserve the normal local tag and retained development.
Require all prior source-generation/allocation, loss/recovery, SDK/public audit,
and topology evidence, with zero source-Inspect ERROR spans. Strict timing and
deliberate rejection markers must remain failed. Development synchronization is
a separate follow-up. Private logs live in `.cache/runtime-inspect-absence-20260921/`.

The isolated candidate is `antnest/runtime-controller:inspect-absence-20260921`,
image ID `sha256:4612f0bcd3bc86a95bd5b71f0de2c5fb509c9ffce819ef67a49d38bbf26137e0`.
Shared fixture/contract/component regression passes 958 tests with five gated
skips and no failures (963 total). It includes positive non-ERROR source absence
with retained HTTP 404/allocation proof and a negative incorrect-outcome check.
Loss project `antnest-lifecycle-ac558bb9` passes both complete business cases and
all twenty request/lifecycle topologies. The two source-Inspect GETs retain HTTP
404 and now have outcome absent, no error attributes/events and no ERROR status.
All Runtime Controller error spans are gone. Four deliberate ACP rejection
markers remain; fifteen strict results retain those markers and timing warnings.
Foundation project `antnest-lifecycle-afe11d64` passes nine lifecycle operations,
normal Controller restart/replay, real Tool Runs and all sixteen topologies.
Runtime Controller has zero error spans. Ten strict results remain failed,
retaining timing warnings, four deliberate rejection markers and three
Controller restart cancellation/ACP stream-interruption markers in the drain
trace. Independent raw inspection initially counted that interrupted ACP span
as a denial; inspecting its operation/outcome separates it from the four actual
rejection markers. The business/topology result is unchanged. Both profiles
retain strict exit 2; this is not full strict deployment acceptance.

Both deployments independently match the candidate image ID. Cleanup confirms
no owned containers, volumes or networks from either profile or the service
database project, no temporary image-reference test resources, and no remaining
verification processes. All twelve retained development containers have the
same IDs, images, mounts, running and health states; eleven health checks pass.
The main Runtime Controller image tag is unchanged and the candidate is retained.
Final JavaScript formatting, diff whitespace and 152 local document links pass.

The service repair and disposable integration batch are complete. Changes remain
uncommitted; no old asset was removed. Next is development deployment
synchronization and regression using this candidate. Interrupted-update and
older Workspace acceptance migration remain later work.

Subsequent [development synchronization](runtime-development-sync-20260921.md)
is now complete: the candidate is deployed, original data/Runtime are preserved,
and nine retained topologies pass including source-missing recovery. Six strict
timing failures remain. This follow-up does not rewrite the candidate evidence
or its deployment state at the time of the original checks above.
