# Runtime reconstruction process-crash component

Date: 2026-09-22 (work began 2026-09-21). The user selected Runtime reconstruction
rather than Agent Session continuation after the [pi reference review](crash-recovery-pi-reference.md).
This is the Runtime Controller-owned batch. Its [contract](../services/runtime-controller/docs/crash-recovery-contract.md)
was written before the component fixture. No production recovery defect was found
in these boundaries, so no production implementation or schema was changed.

## What now has evidence

A test subprocess executes the real control service with the production
PostgreSQL journal/lock adapters and Docker driver. Test-only wrappers exit the
process with code 86, without running deferred cleanup, at a known boundary.
A different process retries the exact Update request against surviving database
and Docker state. This is actual process loss in a component fixture, not a
mocked return error, fabricated journal state, readiness gate or the full server.

| Crash checkpoint                                | Durable/physical facts required before retry                                      | Recovery result                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Before source removal                           | Operation running at attempt 1, original source present, no updated observation   | Same persisted target is allocated; attempt becomes 2                           |
| After source removal                            | Operation running, source absent and no target, original workspace retained       | Target created using the original revision/generation/digest; attempt becomes 2 |
| Target created, terminal journal not committed  | Operation running, new target matches the recorded digest, no updated observation | Exact existing target reused; attempt becomes 2                                 |
| Terminal journal committed, result not returned | Completed operation, exact target and one updated observation                     | Terminal replay preserves attempt 1 and performs no new platform mutation       |

Every case verifies two total generation claims (initial source plus one target),
one updated observation, unchanged workspace identity and exact sentinel bytes,
atomic target publication/released operation ownership, and the matching target
generation claim. Across initialization and reconstruction, the real Docker
adapter records exactly two creates, two starts, one stop and one removal.
Conflicting retry configuration is rejected; a competing request cannot bypass a
nonterminal operation. A second fresh-process terminal replay leaves the complete
journal, physical target and effect ledger unchanged. Final service deletion
removes the test Agent's resources before fixture teardown.

The component provides fixed observation readiness and a verifier that rejects
unexpected readiness calls. It does not start the Runtime Controller HTTP server
or observation monitor. A local UDP sink keeps Runtime's network transport alive;
packet policy and egress functionality are outside this fixture's scope. No
execution publication through Agent Controller is claimed.

## Repeatable entry and resources

From `services/runtime-controller`, run `make test-crash-recovery`. It is an
explicit opt-in target, excluded from ordinary unit and normal-restart runs.
The fixture creates a new PostgreSQL container, internal network, UDP peer,
Skills volume and labeled Runtime resources. Installed images are required;
no image is pulled, rebuilt or deleted. Private optional evidence is described
in the [service README](../services/runtime-controller/README.md).

The first run failed before the crash checkpoints: its placeholder control
address had no route from the internal network. A diagnostic run confirmed the
Runtime bootstrap failure. Using the local gateway supplied a route, but no UDP
listener existed, causing transport exits; two cases passed and two failed.
Adding an owned local UDP peer fixed this fixture dependency. Both subsequent
full component runs passed all four boundaries. Those earlier failures remain
recorded and are not classified as Trace timing issues or production fixes.

## Gates and cleanup

- Full Runtime Controller tests: 352 passing case records, 31 opt-in skips,
  twelve packages passed, including 60 RPC test records.
- Full service race run: the same 352 passing records and 31 skips, no failures.
- Separate disposable PostgreSQL run: 45 passing records, no skips or failures.
- Final Make-driven crash component: all four boundaries pass; final scope is
  `antnest-rc-crash-fef0dcda8c6aff8d`. Per-boundary JSON summaries are private.
- Service lint passes after fixing two unchecked Close returns in test code.
  Go formatting, Markdown formatting/local links and `git diff --check` pass.

Case-record counts include Go subtests. The ordinary-run opt-in skips are not
passing component evidence; the separately executed PostgreSQL and crash runs
supply the evidence above. Existing optional image-reference integration tests
are not newly exercised by this source-only test addition.

Independent cleanup covers five component attempts (including failed runs) and
the PostgreSQL gate: all six scopes have no owned containers, volumes or networks,
and no verification children remain. Twelve retained development containers keep
identity, images, mounts, networks, start times and restart counts. Twelve are
running and eleven configured health checks remain healthy. Private evidence is
under `.cache/runtime-crash-recovery-20260921/` with modes 700/600. No development
service is deployed or restarted; prior uncommitted changes remain preserved.

## Integration required at component completion

The Runtime-owned component batch passed. At its completion, public Controller
Rebuild with Temporal retry after an unfinished Runtime mutation still needed a
separate integration fixture. That batch must prove the same deterministic child request and target,
exactly one execution publication and rebuilt event, preserved workspace, public
replay and deletion. It must use an actual mutation boundary rather than the
retired startup-readiness gate. An intentionally terminated process's unexported
spans remain crash diagnostics; completed recovery requests still need causal
Trace evidence. Deferred nonlogical timing findings and F07 remain out of scope.
This report does not claim that entire business workflow has passed.

The subsequent [Controller/Temporal integration batch](runtime-crash-integration-revalidation.md)
now supplies that separate two-window business and scoped recovery Trace evidence.
This component report retains its original service-owned boundary.
