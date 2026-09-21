# Runtime reconstruction crash integration

Date: 2026-09-22. This follows the
[Runtime-owned component batch](runtime-crash-recovery-revalidation.md) and the
user-selected Runtime reconstruction scope from the [pi review](crash-recovery-pi-reference.md).
It adds a disposable integration fixture and evidence checks, not production
service behavior, schema changes, image builds or development deployment.

## Contract and exercised path

The [integration contract](../scripts/lifecycle-closeout/crash-contract.md) defines
two separately created Agents. Each uses Gateway → Console → Agent Controller
Rebuild → Temporal → Runtime Controller → real Docker. Rebuild explicitly selects
a newer Template revision. Agent Controller and Temporal remain alive while the
test kills only its owned Runtime Controller container with SIGKILL and restarts
that same container. Exit 137, no OOM, unchanged Agent Controller start time, and
the actual persisted/physical checkpoint are required.

| Boundary             | Before the kill                                                                                           | Required recovery                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Before target create | Source removed; workspace retained; target absent; Update journal running, attempt 1                      | Same child request/digest and target revision/generation/spec; create and start that target once |
| After target start   | Docker returned a genuine successful start; target running; response held before the operation can commit | Same target container/start time/workspace; no additional create, start or delete                |

The transparent Unix socket fixture holds only the selected Agent's Docker
request/response in the exact disposable owner scope. It never fabricates Docker
results or edits service journals. Its bounded hold is released by the killed
caller's disconnect; expiry is a fixture failure, not acceptable crash evidence.
Control listens only inside the fixture container. Recorded evidence contains
effect identities, not Docker environment/configuration payloads.

Both cases require Runtime journal attempt 2, two generation claims total
(source plus target), two execution publications total (initial plus rebuilt),
one updated observation and one matching public rebuilt event. Workspace sentinel
bytes survive. Runtime `/status` execution identity matches Controller's published
binding. Exact public request replay changes neither physical state nor event
history. Public Delete removes each Agent's Runtime and workspace before teardown.

## Trace and retry boundaries

Raw Jaeger traces remain private and unmodified. Successful recovery is checked
with `topology_scope=completed_recovery`, never as complete crash Trace evidence.
The successful Runtime SERVER must belong to a new `service.instance.id`; surviving
Workflow/Activity identity and every deterministic child request remain unchanged.
Any excluded failed-attempt/crashed-process span IDs, missing parents, errors and
warnings are retained explicitly. A parent gap in the recovered process or an
unrelated service is a failure. Payload capture and secret checks cover raw spans,
including excluded crash diagnostics.

Temporal can retry while Runtime Controller is still starting. Such transport
attempts must use the same Activity and child request; they do not imply another
Runtime journal mutation attempt. The first run exposed an incorrect fixture
assumption of exactly two Activity spans: before-create had three, after-start
had two. Both business cases passed. A test-first oracle correction accepts a
bounded sequence of failed attempts followed by exactly one success, checking
every attempt's identity. Offline reinspection of both original traces passed;
the original failed result remains retained.

In the existing-target case, probing the old Runtime identity yields the existing
`runtime identity conflict` diagnostic before exact target reuse. Only that
specific platform inspect error is accepted in the recovery check; strict Trace
still fails. Other successful-path errors and repeated Docker mutations fail.
Nonlogical clock warnings remain recorded and deferred. No clock adjustment,
synthetic spans or forced SDK exporter timing was added.

## Verification and repeatability

Run `make e2e-lifecycle-crash` explicitly from the repository root with installed
local images. This target is separate from stable graceful-restart acceptance.
The shared fixture suite runs serially:

```sh
node --test --test-concurrency=1 scripts/*.test.mjs scripts/*/*.test.mjs
```

Shared regression: 1,222 passed, five opt-in skips, zero failures, including 20
new proxy/checkpoint/recovery/Trace cases. Tests were introduced before the new
implementations; the downtime-retry correction also has a reproduced failing test.

First Docker project: `antnest-lifecycle-9df4eda3`. Both crash business cases and
all six public command replays passed. Before-create's initial Trace check failed
only on the incorrect two-Activity assumption; corrected offline checks passed.

Final Docker project: `antnest-lifecycle-89e3c72e`. Both business cases passed,
including six terminal operations and exact-request replays. Four ordinary
lifecycle topologies and two explicitly scoped recovery topologies passed. Each
Rebuild had three Temporal Activity attempts, but only two Runtime journal
attempts (initial plus recovered). No raw synchronous parent edges were missing
in this particular capture; that does not establish full export of the killed
process's spans.

Five of six strict Trace results remain failed: nine error spans (eight Controller
transport/Activity errors from the injected outage, one Runtime identity probe)
and 105 recorded warnings. The final profile reports
`business_and_recovery_topology_passed`, `strict_exit=2`; Make also exits 2.
This is not a full strict-Trace pass.

Both disposable projects are fully cleaned: zero owned containers, volumes or
networks, and zero verification children. All twelve retained containers keep
the same IDs, image IDs, start times, restart counts, mounts and networks; twelve
remain running and eleven healthy. No retained service was restarted.

Evidence is private under `.cache/runtime-crash-integration-20260922/` and
`.cache/lifecycle-crash/<project>/`. Full strict Trace is deliberately not waived;
the profile retains exit 2 for recorded crash/error/timing diagnostics after
business and scoped recovery topology pass.

This is two-window Runtime rebuild recovery acceptance. It does not claim Agent
Session auto-continuation, host/database loss recovery, all possible crash points,
or a new combined full-platform acceptance. F07 remains deferred.
