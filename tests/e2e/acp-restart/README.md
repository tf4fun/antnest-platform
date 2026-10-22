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

The host mounts the three required workload grants and the state/identity/control
contracts read-only, and joins their private networks. The model and client use
the deployed ACP image ID; the Runtime uses the configured deployment image.
The client has no Docker socket, database credential or production collector.

## Trace rules

Trace collection and strict inspection are auxiliary for interrupted requests,
completed requests and lifecycle operations. The collectors retain original
request/result bindings and raw failures under one bounded diagnostic budget.
Missing, incomplete or invalid Trace evidence remains a warning; exhausted
collection is reported as not collected, and an in-flight attempt is cancelled
and joined. It cannot prevent the next business step or substitute for a
business check that did not run.

Confirmed external SDK issues remain non-blocking without additional
investigation or workarounds. SIGKILL ownership, durable Run recovery, replay,
physical effects, access and actual resource cleanup remain independent hard
checks.

Process observations, physical proof, public audits and raw Traces are private
artifacts under `artifacts/verification/acp-restart/<project>/`.

## Cleanup

The host wrapper owns the disposable project and removes its Compose and Runtime
resources, including the replaced Runtime, after success or failure.
Before that fallback teardown, successful Agent deletion must be followed by
empty Runtime-scope container and volume inventories. Runtime Controller releases
Skill references in the delete transaction and reclaims unreferenced volumes
asynchronously. The test therefore polls actual inventories for at most 60
seconds within the original suite deadline; it never removes resources to make
this check pass. Every observation, partial Docker read and original failure is
saved privately. Persistent resources, failed reads, cancellation and evidence
archive failures still fail the suite.
