# ACP process interruption E2E

This opt-in crash-recovery scenario kills the ACP service process at defined
points and verifies recovery for both ACP protocol versions supported by the
installed SDK. Its obligations are defined in the "Process interruption and
unknown Tool effects" section of the
[process interruption contract](contract.md).
Identity deactivation and foreign-Agent access are covered by
[ACP access](../acp-closeout/README.md) and
[identity access](../identity-closeout/README.md).

## Running

```sh
npm --prefix services/agent-acp-service ci
make test-acp-restart-fixtures
make e2e-acp-restart
```

`make test-acp-restart-fixtures` runs serial local contract and HTTP component
checks. `make e2e-acp-restart` requires Docker and the local Stage 3 images
(`make docker-build-stage3`). Set `ANTNEST_E2E_CONTROLLER_IMAGE` and
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` to test other Controller images. Never
run this profile against an existing development deployment.

## Scenario

Four cases run per SDK version: a completed Run, a Run held at a model
response, a Run held after a completed Tool, and a Tool in flight. The profile
must preserve completed history, classify known interrupted Runs and keep
unresolved Runtime effects honest. Before killing an in-flight executor, the
host verifies the physical marker and live PID. After restart, unknown effects
require `runtime_barrier_required` until an explicit Rebuild replaces the
protected Runtime. The old unresolved Run and all earlier events are preserved
through Rebuild, reconnect and later execution.

The client uses the public Provider, Model, Template and audit APIs and has no
database or Docker access. Execution state uses ACP's complete private reader:
each request delegates the original owner login through Identity and verifies
both Principal fields, the Agent and access. Only the exact startup-unavailable
503 is retried. Raw responses are saved with private permissions before returning,
including failed reads; archive failures and cancellation remain failures. The
unknown-effect Runtime barrier stays observable independently of readiness.
Only the disposable host wrapper sends SIGKILL, checks processes, proves Runtime
retirement and cleans up.

ACP connections also use the same original owner through the shared private
opener, which initializes each connection once. The recorder preserves original
inputs, SDK results and errors, raw replies and late updates. Closing joins the
transport and pending request archives before checking the complete inventory:
26 connections/initializations and 46 business requests, including 18 replays.
The original v1 interruption errors and v2 message ID ACKs remain distinct from
the host's SIGKILL proof. Connection, request and initialization inventories are
private; failure output uses a safe summary while full errors and partial
inventory remain private. Cleanup errors cannot hide the original failure.

State and connection migration are local consumer batches. Private Trace
collection and the host's required grants, networks and contract mounts are
subsequent batches before full eight-case Docker acceptance. The previous
platform result does not prove those pending changes.

## Trace rules

The six intentionally interrupted requests report available spans, errors,
warnings and missing parents as diagnostics with `strict_trace=not_applicable`;
they do not require complete Traces. Their SIGKILL and all durable recovery and
effect assertions must still pass. Missing Trace data is reported as
unavailable. Wrong identities, malformed evidence and privacy violations still
fail.

Completed requests and lifecycle operations keep strict Trace checks. Before
another SIGKILL, completed requests must pass topology, protocol and privacy
inspection through bounded polling and then be archived. A pause in span
arrivals alone is not evidence, and the SDK's five-second batch interval does
not guarantee backend visibility after five seconds. The reviewed clock-skew
warning (`clock skew adjustment disabled; not applying calculated delta of ...`)
is reported in
`strict_trace` but does not fail the exit.

Confirmed external SDK issues are also non-blocking under the repository policy;
retain diagnostics without adding investigations or workarounds. Internal service
logic and the recovery business assertions still require acceptance.

Process observations, physical proof, public audits and raw Traces are private
artifacts under `artifacts/verification/acp-restart/<project>/`.

## Cleanup

The host wrapper owns the disposable project and removes its Compose and Runtime
resources, including the replaced Runtime, after success or failure.
