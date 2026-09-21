> Lifecycle execution update (2026-09-12): all Agent Controller lifecycle
> operations now use Temporal. PostgreSQL stores business phases and results,
> not worker leases or attempt counters. C3's checkpoint/recovery checks retain
> immutable child request, target Runtime and workspace proofs; workflow recovery
> is provided by Temporal. No Agent Controller lease-expiry assumption remains.
> A killed, unexported SDK span is an explicit Jaeger evidence gap, not a
> fabricated span or a reason to accept a disconnected trace.

# Lifecycle Closeout

The default `foundation` entry has a current-contract replacement described in
[migration-contract.md](migration-contract.md). The network profile's current
contract is in [network-migration-contract.md](network-migration-contract.md).
The shutdown profile uses [shutdown-migration-contract.md](shutdown-migration-contract.md).
Health uses [health-migration-contract.md](health-migration-contract.md).
Restore uses [restore-migration-contract.md](restore-migration-contract.md).
Loss uses [loss-migration-contract.md](loss-migration-contract.md).
Interrupted-update uses [interrupted-migration-contract.md](interrupted-migration-contract.md)
for normal committed-response recovery. The old abrupt-crash source graph is
[retired with its fault scope recorded](../../docs/interruption-assets-retirement.md). Workspace protocol now uses the same Foundation runner with its
[own current contract](../workspace-closeout/protocol-migration-contract.md);
the [four-scenario browser profile](../../docs/workspace-browser-revalidation.md)
also migrated. The [retirement audit](../../docs/acceptance-retirement-audit.md)
identifies the old lifecycle fallback and shared helpers. The
[first cleanup](../../docs/acceptance-retirement-revalidation.md) removes the
unreachable fallback and old admission graph; current shared helpers remain.
The [2026-09-21 report](../../docs/lifecycle-foundation-revalidation.md) records
nine completed operations and 15 passing Trace topologies; the graceful-restart
Rebuild trace still fails on two missing Workflow-parent edges. The
[Controller follow-up](../../docs/controller-workflow-span-revalidation.md) now
passes all 16 topologies with zero missing parents in an isolated candidate.
Strict warnings/errors remain failed. The later
[development synchronization](../../docs/controller-development-sync-20260921.md)
deployed the Controller repair and repeated scoped regression.

The opt-in Runtime reconstruction crash profile now has its own
[contract](crash-contract.md) and [integration report](../../docs/runtime-crash-integration-revalidation.md).
Run `make e2e-lifecycle-crash` separately. It kills only the disposable Runtime
Controller at real Docker mutation boundaries, keeps Agent Controller/Temporal
alive, and verifies immutable retries, workspace retention and single publication.
This is separate from the normal committed-response restart profile. Successful
recovery topology is scoped explicitly; raw crash/error/timing evidence remains
strictly failed and the diagnostic target can return exit 2.

These are disposable Docker integration profiles for C3/C5, not another option on
the general Stage 3 launcher. All business commands enter through Edge Gateway
and Admin Console. Docker inspection is used only as independent physical
evidence and to place/read a synthetic workspace sentinel; it does not update
service databases or fabricate lifecycle outcomes.

Run serially from the repository root:

```sh
make test-lifecycle-fixtures
COMPOSE_PARALLEL_LIMIT=1 make docker-build-stage3 -j1
make e2e-lifecycle
```

Use `ANTNEST_E2E_CONTROLLER_IMAGE=<image-or-immutable-ID>` to select an isolated
Controller candidate, or `ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE=<image-or-immutable-ID>`
for Runtime Controller; deployment checks compare the actual image IDs. Defaults
remain `antnest/agent-controller:local` and `antnest/runtime-controller:local`.
The disposable Foundation, network, shutdown, health, restore, loss and interrupted-update profiles
consume these options through their shared Compose override.

The profile chooses unused ports/network ranges, creates one isolated Compose
project, uses synthetic administrator/provider data and the locally built
immutable Runtime image. It never loads `.secret`, calls an external model,
replaces a retained development stack or keeps a stack after failure. One
Postgres instance hosts service-owned databases. Runtime creators are stopped
before cleanup; test-owned containers, volumes and networks must all be gone
before a passing summary is printed. Every Docker command has a deadline and
its process group is killed on timeout. A failed/partial run is not evidence.

## Evidence Boundary

The foundation profile verifies:

1. Empty instance, model, Template, active owner and ready Agent, via Gateway.
2. Create/rebuild/disable/enable/delete reach durable terminal state. Replaying
   each exact request key returns the same operation and does not repeat effects.
3. Template publication leaves existing configuration/physical container alone;
   explicit rebuild changes compute but preserves workspace bytes. Disable
   removes compute and keeps those bytes; enable reuses them. Delete removes
   both resources, hides the Agent from inventory and retains events/operations.
4. Network assignment GET/CAS/replay/conflict through the new Console entry,
   including policy changes while disabled without opening the attachment.
   Assignment acknowledgement is **not** evidence of actual TUN packet flow.
5. Paginated global-cursor event replay and restart of the controller after
   terminal operations preserve the journal and request identity.
6. Lifecycle traces bind the exact Gateway/Console admission and request ID to
   the Temporal workflow, its activities, committed driver writes and identified
   Runtime/Egress mutations. Drain includes ACP snapshot publication and matching
   settlement acknowledgement. ACP Runs have their own message traces and public
   audit identity; they do not acquire Controller admissions.
7. All twelve Compose services, including Temporal, must be present and running;
   services with health checks must be healthy. Eight application containers use
   the locally built image IDs. Only Gateway, PostgreSQL, Jaeger and the model
   publish the exact allocated loopback ports. Temporal remains private. Dynamic
   network allocation excludes reserved Runtime infrastructure addresses.

The foundation collector uses the current Stage 3 lifecycle and per-request ACP
oracles. Actual JSON-RPC request IDs and connection links distinguish repeated
methods on the same Session. Provider HTTP CLIENT spans bind both completed Runs
to their model requests and Runtime tool descendants. Supplied synthetic
passwords, model keys and actual session cookies must not appear in traces;
RPC content capture is disabled. This is a bounded canary scan.

Raw Jaeger spans and private diagnostics stay in ignored
`.cache/lifecycle-foundation/<project>/`; the printed result contains compact
business and topology evidence. Completed traces must pass topology checks and
converge across three samples. A topology failure remains an exit-1 result while
subsequent lifecycle traces are collected. Raw warnings and error spans remain
present and make the strict exit nonzero. Export completion does not waive timing warnings.

## Whole-Platform Stream Shutdown

`make e2e-lifecycle-shutdown` runs separately from the other profiles, with real
Gateway, Console, Identity, Controller, ACP, Egress and PostgreSQL services and
Temporal and OTLP enabled. It reuses the current Foundation setup and deployment
checks; [revalidation evidence](../../docs/lifecycle-shutdown-revalidation.md)
records its scoped results. It creates an idle Agent through Gateway and holds three real
connections open: the administrator lifecycle event watch, the owner's workspace
state watch and an initialized ACP v1 WebSocket with a persisted empty Session.
Every observer must receive a valid initial result and remain open before stop.

The coordinator stops the eight application services with ordinary Compose
SIGTERM, without first closing client connections. All must exit zero without
OOM/forced termination; the remote ends must close the watches and WebSocket.
Temporal is then stopped before PostgreSQL; both must exit zero. Jaeger stays
up long enough to verify finished Gateway-rooted watch spans. Administrative
events traverse Identity/Console/Controller; owner execution state uses Identity
and ACP's POST `/rpc/agent-acp/watch-agent-execution-state`, with no Controller
state dependency. State carries a configuration digest, not `agent_revision`.
The SSE client records the actual response Trace ID, without injecting a
synthetic unexported parent. Every raw span is checked for topology/capture and
supplied secrets; private raw evidence is saved for diagnosis.
An HTTP receive stream can finish as `handler_aborted` during maintenance.
The exact Gateway Watch root may carry that error only when it also carries
`antnest.http.request_cancelled=true`, retain HTTP 200 and finish inside the
observed stop window (one second of host/VM clock tolerance). The cancellation
is reported separately from normal completion. The current oracle also recognizes
exact HTTP-200 watch-path cancellation in the same window: direct Gateway CLIENT
`cancelled`, Console event SERVER/Controller CLIENT `cancelled`, Controller event
SERVER `canceled` with `request_failed`, and ACP execution-state SERVER
`stream_interrupted`. It requires the owning route/method and ancestry and rejects
conflicting error events. All remain raw errors and strict failures. Other
dependency errors, arbitrary panics and unclassified aborts still fail; the stop
and remote-closure checks must pass before any trace is inspected.

Restart starts the existing PostgreSQL, Temporal and application containers in
dependency order, without rerunning one-shot schema jobs or recreating resources.
It uses the same containers, databases, configuration and cookies. The
same Agent and workspace must remain; the same ACP Session loads without a Run
or model call, verified by public execution audits and model request history.
Session metadata and the full Agent event journal remain unchanged. Fresh watches must receive the same authoritative state/event
history. Dynamic Runtime compute is deliberately not managed by Compose: it
must remain the same running container, matching the operator runbook. Finally
normal Agent deletion and exact-scope cleanup remove the disposable resources.
The two ACP requests and Create/Delete operations also retain their current
per-message and lifecycle topology checks. Warning/cancellation errors remain
strict failures; topology failure exits 1 and strict-only failure exits 2.
This tests idle-stream coordinated maintenance, not force-killing an active
Tool, browser rendering or every ACP transport/version combination.

The migration originally left stable acceptance incomplete: one full run passed,
but two repeats failed at post-restart Delete with Temporal membership unavailable
despite TCP health. The separate [readiness repair](../../docs/temporal-readiness-revalidation.md)
uses frontend initialization and live service rings, plus a direct Controller
startup dependency. Its repeated candidate results remain separate from the
original failures; strict Trace warnings/cancellation errors are not waived.

## Offline Backup And Restore

`make e2e-lifecycle-restore` uses current Foundation setup and a deterministic
Tool model. It normally disables its Agent, stops application writers followed
by Temporal, then exports seven databases, workspace/system Skills archives and
three encryption keys. Complete inventory, checksums and ownership are checked
before replacing only owned storage. Original roles and empty databases are
created before restoring data; schema initializers and writers wait until frozen
row/sequence/ownership/ACL fingerprints and file archives match.

The isolated diagnostic Jaeger stays running across storage replacement to retain
both sides' traces. The model is recreated. Current public audit and Agent event
history must survive; exact Session replay makes no model call or new Run.
Prompt on an untouched restored Session exercises its saved encrypted MCP
revision and one new Tool Run. Normal Delete removes Agent resources before
shutdown and collection of lifecycle/SDK request traces. Strict warnings remain
failed. See the [operational procedure](../../docs/docker-backup-restore.md) and
[migration evidence](../../docs/lifecycle-restore-revalidation.md).

## Runtime Health And Observation

`make e2e-lifecycle-health` uses current Foundation setup and validates Engine
health, Controller's Runtime state and ACP execution availability independently.
It retains two 60-second idle CPU samples, the bounded unprivileged calibration,
fast startup probes and steady 10-second/three-failure health policy. Samples
must preserve the original process and binding.

Only the test-owned Runtime is paused with SIGSTOP. After three failed checks,
both Controller unhealthy and ACP offline must be observed. SIGCONT is sent by
an independent cleanup client even if the scenario is interrupted. Health
recovery within the same process preserves its execution identity and workspace.
An ordinary exit-zero stop/start then proves a new healthy process cannot reuse
the old executable binding. Explicit Rebuild restores availability with retained
workspace and new revisions; Delete removes the test resources. No Run or model
call is allowed. Create/Rebuild/Delete use current Trace oracles and retain strict
failures. See [current evidence](../../docs/lifecycle-health-revalidation.md).

## Runtime-start Failure Batch

Create another Template with a required managed MCP command that does not exist
in the Runtime image. Use that Template's returned revision. Current lifecycle
creation completes its durable provisioning phases; separately observed Runtime
startup becomes unhealthy/exited (or restarting) without an executable binding.
Correlate actual owned-container JSON logs with Agent/generation and the missing
MCP's startup failure so an unrelated network fault cannot satisfy the scenario.

Inspect the failed compute and allocated workspace, replay the same create
request without changing either, then delete the Agent through Gateway. Both
resources must be absent before teardown. Retain the completed create/delete
operations and their exact events after deletion and an idle worker restart;
replay must not recreate resources or duplicate events. Both lifecycle traces
must retain the full current workflow/driver topology. The observed failed
Runtime is not represented as a failed provisioning operation.

## Active Run And Rebuild Batch

The local model fixture makes the owner send an ACP v1 prompt that invokes a
real Runtime `bash` tool. The shell writes a start marker and waits for a file
barrier. Publish a Template revision without changing the current Agent, then
admit rebuild through Gateway while that tool is still running. Require durable
`running/drain`, the original executable binding and physical container, an
open network attachment, and only the first workspace effect. A second Session
must receive `agent_busy` (`-32020`, nonretryable), with no updates, Run intent,
model request or tool dispatch.

Restart only the disposable Agent Controller with graceful Docker stop/start
while drain is nonterminal. Inspect the stopped container before starting it:
exit code zero, no OOM/error and a completed stop are required, rather than
assuming Docker's stop timeout did not escalate to a forced kill. At each drain
checkpoint, require a positive unchanged shell PID, successful liveness check
and absence of the release file. The ACP service, Runtime, shell and pending prompt
must survive unchanged. Trace validation requires both original Workflow spans with matching
Workflow/Run identity: the stopped worker ends its span with `worker_shutdown`,
and the replacement ends with `workflow_return`. The retried drain retains its
durable scheduling parent, while later Activities descend from the new worker
span. The interrupted drain requires a committed journal read and publication
acknowledgement SQL; the successful retry requires its committed phase write.
Both attempts must use the same acknowledged ACP snapshot revision. Cancellation errors remain visible and strict failures. Repeating the same rebuild request must identify the
same operation. Repeat the blocked prompt assertion after restart, release the
file barrier, and require the held Run to complete before Runtime replacement.
Reconnect after the access revision changes and load the same ACP Session ID
before sending another prompt: the model must see the new
Template guidance and an environment-rebuild notice, and a real Runtime `read`
must return the exact two workspace effects, without replaying the old tool.

Retain compact evidence for two completed Runs, two rejected prompts, exact
physical effects, a verified Controller process restart and current lifecycle
and per-message ACP traces. Public audits must retain the held Run snapshot and
bind the second Run to the rebuilt Agent execution revision. Session load must
replay the exact visible persisted history without changing audits or model calls. Close both ACP connections
before collecting their completed Gateway spans. Correlated model calls and
Runtime dispatch/tool spans must descend from the same ACP Run using same-trace
parent references and the actual durable Run ID. The model accepts only
these synthetic prompts, rejects duplicates, and never calls an external model.
Its control/status port is bound to loopback only in this disposable profile.

This graceful restart does not claim SIGKILL recovery or loss of a
Runtime-mutation response. The interrupted-update profile below covers a lost
committed response with normal Controller stops. Unfinished physical-effect
crash recovery remains a separate fault scope without current E2E acceptance. The original C3 checklist also
required real allowed/denied TUN traffic; the separate
[network migration](../../docs/lifecycle-network-revalidation.md) now supplies
that scoped evidence. Browser component evidence lives in Console;
this profile does not claim browser acceptance or complete C3-01..05 by itself.

Keep the compact result in the revalidation report and raw evidence private.
Fixture tests reject disconnected spans, incorrect execution revisions, forged
causal links, missing phases and duplicate or incorrect event cursors.

## Interrupted Runtime Update

`make e2e-lifecycle-interrupted` now uses current Foundation deployment and
catalog setup with the [migration contract](interrupted-migration-contract.md).
A private transparent HTTP fixture holds one selected Agent's real completed
Runtime Update response. The checkpoint requires Agent Controller still at
`running/runtime_update` without a result, and the exact Runtime child already
committed with a physically present target. No response is fabricated.

Both Controllers stop normally, Agent Controller first, and must exit zero.
The fixture must record caller cancellation, not expiry. Restart Runtime
Controller first, then Agent Controller. Temporal retries the same Activity;
the same terminal child response and target are reused with no mutation attempt,
extra generation, workspace replacement or duplicate updated/rebuilt event.
Exact Gateway replay and final public Delete remain required.
Catalog revision creation must leave the existing Agent unchanged. Rebuild selects
the new Template revision and recovery verifies its changed request budget,
unchanged remaining configuration and original workspace bytes.

The trace oracle preserves both actual Workflow parents, both Update attempts,
the successful first Runtime SERVER and the canceled caller. It checks matching
receipt hashes/identities and no Docker work on terminal retry. Cancellation and
clock warnings remain strict failures. Deployment credentials, raw journals and
traces stay in private ignored evidence; final results follow owned cleanup.

The old startup-gate/SIGKILL flow, overlay, image recipe and exclusive Trace
collector are [retired](../../docs/interruption-assets-retirement.md). Current
provisioning no longer waits for Runtime readiness, so that gate cannot establish
a running Update. This normal-restart profile does not claim unfinished Runtime
mutation crash recovery or lease expiry. Historical failure records and existing
service recovery tests remain, with no claim of new crash E2E evidence.
Current Update/loss consumers import `recovery-support.mjs`; their physical
inspection reads Docker inventory and inspect data. Shared observability
`evidence.mjs` and current collectors remain in use.

## Runtime Network Policy

The [current network revalidation](../../docs/lifecycle-network-revalidation.md)
records the migrated consumer and retained strict failures.
The network profile uses raw TCP/NDJSON, not HTTP or proxy environment variables.
Two real ordinary-user Runtime tools hold separate connections. After Agent A's
deny ACK, its original conntrack entry must be absent while B's original entry
remains. The target pushes data on both old sockets: A must not receive it, A's
next write must be rejected promptly, and B must receive and continue on the same
socket. Exact-request policy replay is tested afterward because assignment replay
may legitimately clear existing connections. A stale conflicting request for B
must leave B's connection usable.

A separate fail-closed forwarding guard is installed in the disposable Egress
namespace before DNAT. Only the exact test target can receive TUN-origin traffic;
loss of the DNAT rule must not send the synthetic public destination to Internet.
No host firewall/routes or production policy implementation is changed.

`make e2e-lifecycle-network` reuses the current Foundation empty-instance Gateway
setup and exact lifecycle replay helpers, but runs a separate network scenario instead of
repeating the drain/crash profiles. Two Agents use real ACP v1 prompts, the
deterministic local model and actual Runtime `bash` execution as UID/GID 1000.

The target is an isolated TCP fixture with a separate HTTP control port. A test-only DNAT rule in the disposable
Egress namespace maps `1.1.1.1:18080` from its TUN to that fixture. The Rust policy
still evaluates the original external-class address before writing to TUN; the
ordinary kernel forwarding and return path remain in use. No host route, host
firewall, production policy rule or service implementation is changed. This is
real packet-path evidence, not a claim about a public site's uptime or ISP route.
The fixture is reachable on the Egress test network only, not Runtime management.

Require allow -> deny -> allow on Agent A while Agent B stays allowed. In addition
to fresh connections, hold a TCP connection in A's running tool,
change its policy through Gateway, then attempt a second request on that same
socket. Denied requests must return a connection rejection/reset promptly, never
pass merely because a tool or network timeout expired. DNS uses the configured
Runtime resolver (TCP) with bounded resolver attempts. Independent target health,
unique per-probe responses and exact target hit history distinguish policy denial
from a dead endpoint. Raw TCP clients bypass proxy environment variables.

Policy updates/replay must not change Runtime container, generation, start time,
workspace or executable configuration. Correlate administrative policy RPC spans
through Gateway -> Console -> Agent Controller -> Egress. Prompt/model/tool spans
stop at Runtime; do not add per-packet OTLP. Delete both Agents through Gateway
before teardown and retain only final compact metrics.

DNS denial needs both a bounded resolver error and a direct TCP connection
rejection to the configured resolver; a timeout alone is not evidence. Agent B
must still resolve the target while A is denied. Each prompt must have exactly
one completed public Run audit for its actual Agent, Session and execution
revision. Actual SDK request IDs and connection links identify six new-Session
and six prompt traces; twelve Provider HTTP calls and six Runtime Bash calls
must descend from their durable Runs. No Controller admission/finish RPC is
expected. Four lifecycle traces use the current Temporal, committed SQL and
publication/settlement contract; four policy-write traces require the exact
Agent and Gateway/Console/Controller/Egress ancestry.

The deployment checks all thirteen services and eight application image IDs.
The additional target is healthy, has no host ports and belongs only to the
test Egress network. Temporal remains private and dynamic network allocation
reserves the static infrastructure addresses. Raw traces and failure diagnostics
are saved privately under `.cache/lifecycle-network/<project>/`. Topology failure
exits 1; warnings/errors retain strict exit 2 without rewriting evidence.

After deleting both Agents, gracefully stop all trace producers
and verify clean exits so telemetry shutdown completes before Jaeger collection.
For both Runtimes, retain Docker die/stop/destroy events from their normal business
Delete: exactly one exit code 0, no OOM or SIGKILL, exact owned container identity.
Stable index samples alone are not used as a producer-completion barrier.

## Unplanned Runtime Loss

`make e2e-lifecycle-loss` uses current Foundation setup and two disposable Agents.
Each completes a real Bash append before its idle Runtime is normally stopped,
verified exit-zero/no-OOM, and removed without force. In the live case the
Controller observes exit invalidation before container removal; independently
require `runtime_deleted / docker_event` from the Runtime journal. In the cold
case Runtime Controller is normally stopped before removal, then restarted to
require `runtime_missing / platform_reconciliation`. Fault targets must match
exact inspected container, project scope and Agent identity. Workspace remains.

Current Controller invalidation uses fresh Inspect: its public/private loss
event has a `runtime-condition-loss-` identity and zero direct journal sequence.
The live audit retains `runtime_exited`, the cold audit `runtime_missing`.
Validate producer sequence, route, Agent, Runtime revision, generation and
physical identity separately; a generic unavailable result cannot substitute.
Runtime Inspect must report provisioned/absent without executable fields.
The configured spec and last successful execution lineage remain preserved.

ACP state must become offline; Prompt rejects with `-32020/agent_unavailable`
without notifications, model invocation or new Run audits. Explicit Rebuild
uses the same Template revision with exact idempotent replay. Load the same
Session without executing history, then use real Read to verify original bytes
and the model-visible reset notice. Require new compute/Runtime/execution
identity, unchanged configuration and workspace. Another normal Runtime
Controller restart must preserve the replacement and exact loss/event history.

After business Delete, flush producers normally and collect six lifecycle plus
fourteen actual SDK request traces, including two protected rejections. Keep
strict timing warnings and rejection ERROR spans failed. This is idle live/cold
loss recovery; in-flight crashes and artificial delayed observations retain their
separate scenarios. See [current evidence](../../docs/lifecycle-loss-revalidation.md).
