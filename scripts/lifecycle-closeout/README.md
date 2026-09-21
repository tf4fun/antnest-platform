> Lifecycle execution update (2026-09-12): all Agent Controller lifecycle
> operations now use Temporal. PostgreSQL stores business phases and results,
> not worker leases or attempt counters. C3's checkpoint/recovery checks retain
> immutable child request, target Runtime and workspace proofs; workflow recovery
> is provided by Temporal. No Agent Controller lease-expiry assumption remains.
> A killed, unexported SDK span is an explicit Jaeger evidence gap, not a
> fabricated span or a reason to accept a disconnected trace.

# Lifecycle Closeout

The default `foundation` entry has a current-contract replacement described in
[migration-contract.md](migration-contract.md). Network, shutdown, health,
restore, loss, interrupted-update and older Workspace consumers remain separate
migration batches. Their historical sections below are not current acceptance.
The [2026-09-21 report](../../docs/lifecycle-foundation-revalidation.md) records
nine completed operations and 15 passing Trace topologies; the graceful-restart
Rebuild trace still fails on two missing Workflow-parent edges. The
[Controller follow-up](../../docs/controller-workflow-span-revalidation.md) now
passes all 16 topologies with zero missing parents in an isolated candidate.
Strict warnings/errors remain failed; retained deployment is pending.

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
Controller candidate; deployment checks compare its actual image ID. The default
remains `antnest/agent-controller:local`. Only this disposable Foundation Compose
override consumes the option in this directory.

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
OTLP enabled. It creates an idle Agent through Gateway and holds three real
connections open: the administrator lifecycle event watch, the owner's workspace
state watch and an initialized ACP v1 WebSocket with a persisted empty Session.
Every observer must receive a valid initial result and remain open before stop.

The coordinator stops the eight application services with ordinary Compose
SIGTERM, without first closing client connections. All must exit zero without
OOM/forced termination; the remote ends must close the watches and WebSocket.
The database is then stopped cleanly. Jaeger stays up long enough to verify
finished Gateway-rooted watch spans and their actual Identity/Console/Controller
ancestry. Egress packet tracing remains excluded. Only bounded trace summaries
and supplied synthetic-secret scans are retained.
An HTTP receive stream can finish as `handler_aborted` during maintenance.
Only the exact Gateway Watch root may carry that error: it must also carry
`antnest.http.request_cancelled=true`, retain HTTP 200 and finish inside the
observed stop window (one second of host/VM clock tolerance). The cancellation
is reported separately from normal completion. Dependency errors, arbitrary
panics and unclassified aborts still fail; the stop and remote-closure checks
must pass before any trace is inspected.

Restart uses the same containers, databases, configuration and cookies. The
same Agent and workspace must remain; the same ACP Session loads without a Run
or model call. Fresh watches must receive the same authoritative state/event
history. Dynamic Runtime compute is deliberately not managed by Compose: it
must remain the same running container, matching the operator runbook. Finally
normal Agent deletion and exact-scope cleanup remove the disposable resources.
This tests idle-stream coordinated maintenance, not force-killing an active
Tool, browser rendering or every ACP transport/version combination.

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
Runtime-mutation response. The interrupted-update profile below covers the
nonterminal physical-effect crash separately. Still required before full C3
acceptance: real allowed/denied TUN traffic. Browser component evidence lives in Console;
this profile does not claim browser acceptance or complete C3-01..05 by itself.

Keep the compact result in the revalidation report and raw evidence private.
Fixture tests reject disconnected spans, incorrect execution revisions, forged
causal links, missing phases and duplicate or incorrect event cursors.

## Interrupted Runtime Update

`make e2e-lifecycle-interrupted` is a separate disposable profile. A derived
test-only Runtime image waits on a workspace file before executing the unchanged
Runtime binary. After Gateway admits a rebuild, the checkpoint must prove that
the old container is gone and the exact target container exists but is not ready.
Read-only, service-owned journal queries must agree: Agent Controller still owns
`running/runtime_update`, has no Runtime result, and references that same running
Runtime Controller operation. No credentials, specs or raw journals are retained.

Briefly pause Agent Controller, then SIGKILL Runtime Controller and Agent
Controller. Freezing the caller preserves the targeted in-flight checkpoint
between the kills. Inspect exit code 137, no OOM and unchanged container
identity, then re-read the frozen business journals before releasing the gate.
Reject a completed/unknown child or changed parent phase at that checkpoint.
Release the startup gate and restart the same Controllers. Temporal retries the
interrupted Activity; the profile does not edit service records or emulate a
scheduler. Runtime Controller retains its own platform-operation recovery.

After recovery, require the same child request, target revision, generation,
digest, container and workspace; one new execution publication and one Runtime
updated observation. Exact Gateway replay must not create additional effects.

All SDK Activities and downstream calls must retain the Gateway admission trace.
SIGKILL may lose an unexported span; the trace oracle reports that evidence gap
rather than manufacturing a parent or weakening ancestry checks. Final results
are emitted only after resources owned by this profile have been removed.

## Runtime Network Policy

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

`make e2e-lifecycle-network` reuses the empty-instance Gateway setup and exact
lifecycle replay helpers, but runs a separate network scenario instead of
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
must still resolve the target while A is denied. Trace acceptance checks the
owning repository's released/completed/settled admission, correlated to the exact
ACP finish RPC. After deleting both Agents, gracefully stop all trace producers
and verify clean exits so telemetry shutdown completes before Jaeger collection.
For both Runtimes, retain Docker die/stop/destroy events from their normal business
Delete: exactly one exit code 0, no OOM or SIGKILL, exact owned container identity.
Stable index samples alone are not used as a producer-completion barrier.

## Unplanned Runtime Loss

`make e2e-lifecycle-loss` exercises two disposable Agents independently: remove
one running Runtime while its Controller is online; stop the Runtime Controller,
remove the second Runtime, then restart that Controller. Require observed
unavailability, an empty executable binding, retained recovery lineage and one
loss audit event attributed to the old Runtime revision. Docker faults must
target the exact inspected container with matching project scope and Agent label.
Neither case deletes the workspace volume or alters any service database.
The public event envelope is correlated with its internal event and producer
observation through fixed read-only queries using each service's own database
role. The live path must be `runtime_deleted / docker_event`; the cold path must
be `runtime_missing / platform_reconciliation`. A generic unavailable state
cannot substitute for either. Runtime Inspect must report the retained logical
head as ready/absent, without an executable endpoint. The recovery spec is
retained; only the physical/execution binding is cleared.

Before each loss, the owner sends an ACP v1 prompt that invokes a real Runtime
`bash` append. After loss, a prompt must be rejected without a model invocation.
Rebuild uses only the existing Gateway lifecycle command and Template revision;
exact-request replay must not repeat mutations. Load the same Session after
replacement without executing its history, then use the real `read` tool to
verify the original bytes. Require a distinct container/execution revision,
the same workspace and a model-visible environment-reset notice. A second
Controller restart must not invalidate the replacement or duplicate loss audit.

Collect the initial write's Gateway-rooted trace before deleting its Runtime,
then collect recovery prompt traces and admission-linked lifecycle traces.
This profile covers deployed live/cold loss recovery, not browser interaction,
forced in-flight Tool interruption, or artificial late-event delivery. The latter
is separately covered by Controller PostgreSQL regression tests. Only print a
passing summary after all owned resources have been removed.
