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
make e2e-acp-restart-auto
make e2e-acp-restart-manual-ui
make e2e-acp-restart-notify-ui
```

`make test-acp-restart-fixtures` runs serial local contract and HTTP component
checks. `make e2e-acp-restart` requires Docker and the local Stage 3 images
(`make docker-build-stage3`). Set `ANTNEST_E2E_CONTROLLER_IMAGE` and
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` to test other Controller images. Never
run this profile against an existing development deployment.

## Scenario

The default manual profile runs four cases per SDK version: a completed Run, a Run held at a model
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

The host mounts the four required workload grants and the state/identity/control
contracts read-only, and joins their private networks. The model and client use
the deployed ACP image ID; the Runtime uses the configured deployment image.
The client has no Docker socket, database credential or production collector.

## Automatic recovery

`make e2e-acp-restart-auto` runs a separate disposable v2 in-flight case. Before
creating the Agent, an authenticated administrator configures the Organization's
`auto` policy through Controller's real policy API. After the physical Bash
marker/PID barrier, the host kills and restarts ACP. The client never sends a
Rebuild request. Controller must admit and finish the unique original recovery.

The host reads only binding and recovery metadata from the owned PostgreSQL
container with each service's database role and read-only transactions. It keeps
all historical ACP cycles and Controller recovery/Rebuild rows for this Agent;
it does not filter out retired cycles or unexpected request IDs. The original
cycle, frozen policy and configured Template, command fingerprint, cooldown,
start confirmation, requested event and completed operation must agree. Raw
observations are private. This avoids requiring a transient offline state that
may already have ended when the client reconnects.

The client independently checks the public operation and Runtime journal, changed
Runtime/execution identities, unchanged old Run/events, three history replays
without inference, and a new successful Run. The host proves the old Runtime is
physically gone and verifies deletion/cleanup. The fixed profile requires four
joined connections, seven original ACP requests, two Runs (one unresolved and
one completed), three model requests and one automatic Rebuild. The original
eight manual cases retain their explicit barrier/refusal checks.

## Browser recovery

The `manual-ui` and `notify-ui` targets each run one separate real v2 in-flight
crash against the complete deployment. Install the Agent UI web dependencies
and Playwright Chromium for local targeted runs; remote CI supplies both.
The client publishes its original binding only after checking the interrupted
Run and preserved history, then waits for the browser. It never sends Rebuild
in either profile.

An actual owner login observes the recovery reason in Workspace. The manual
case uses an administrator owner and follows the existing Console link; the
notify case uses a member owner and verifies that only the administrator-contact
guidance is offered. A separate administrator browser confirms recovery through
Console with the original barrier, configured Template, request ID and CSRF pair.
The original operation lookup must return typed `operation_not_found` before
the sole recovery POST. Opening the dialog and refreshing must not dispatch.

Read-only PostgreSQL inventories prove that the worker observed the current
binding and policy without admitting a Rebuild before confirmation. Notify
requires one stable journal notification and its extension; manual requires none.
Orphan journal entries and wrong-Agent references remain visible and fail
admission. The browser closes and joins all readers before releasing the client.
The original manual receipt, cooldown and completed operation are verified;
the existing client then checks physical Runtime replacement, unchanged history,
one successful new Run and actual deletion/cleanup. These profiles each require
four joined ACP connections, seven original requests and three model requests.

All four restart profiles belong to the remote `c-acp-recovery` gate. Source and
fixture checks alone do not establish that the real browser or Docker cases passed.

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
