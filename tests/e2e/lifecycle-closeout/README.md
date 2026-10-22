# Lifecycle Closeout

These disposable Docker profiles test Agent lifecycle end to end: create,
rebuild, disable, enable and delete, plus shutdown, health, backup and restore,
interrupted updates, network policy and Runtime loss. Every business command
enters through Edge Gateway and Admin Console. Agent Controller runs all
lifecycle operations as Temporal workflows. PostgreSQL stores business phases
and results, not worker leases or attempt counters.

Docker inspection is used only as independent physical evidence and to place
or read a synthetic workspace sentinel. It never updates service databases or
fabricates lifecycle outcomes. The independent storage-only suite seeds its
own recovery fixtures after all application writers have stopped; it does not
claim business lifecycle or ACP acceptance.

The fixture environment explicitly supplies fixed database passwords and the
`ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` opt-in through a test-only Compose override.
Operator deployments use the [random environment generator](../../../contracts/platform/development-secrets.md).

## Running

Run serially from the repository root:

```sh
make test-lifecycle-fixtures
COMPOSE_PARALLEL_LIMIT=1 make docker-build-stage3 -j1
make e2e-lifecycle
```

| Target                                  | Profile                                                   | Contract                                                                    |
| --------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `make e2e-lifecycle`                    | Foundation, including the active-Run drain                | [migration-contract.md](migration-contract.md)                              |
| `make e2e-lifecycle-shutdown`           | Whole-platform stream shutdown and restart                | [shutdown-migration-contract.md](shutdown-migration-contract.md)            |
| `make e2e-lifecycle-health`             | Runtime health and observation                            | [health-migration-contract.md](health-migration-contract.md)                |
| `make e2e-lifecycle-restore`            | Offline backup and restore                                | [restore-migration-contract.md](restore-migration-contract.md)              |
| `make e2e-stage4-skill-storage-restore` | Independent Skill storage recovery                        | [restore-migration-contract.md](restore-migration-contract.md#recovery-set) |
| `make e2e-lifecycle-interrupted`        | Interrupted Runtime update with a lost committed response | [interrupted-migration-contract.md](interrupted-migration-contract.md)      |
| `make e2e-lifecycle-network`            | Runtime network policy on the real packet path            | [network-migration-contract.md](network-migration-contract.md)              |
| `make e2e-lifecycle-loss`               | Unplanned Runtime loss, live and cold                     | [loss-migration-contract.md](loss-migration-contract.md)                    |
| `make e2e-lifecycle-crash`              | Opt-in Runtime Controller crash during reconstruction     | [crash-contract.md](crash-contract.md)                                      |

The workspace protocol profile reuses the same Foundation runner; see
[its contract](../workspace-closeout/protocol-migration-contract.md).

The independent Skill storage target builds fresh candidate images and checks
all fifteen services and nine application image IDs. It restores eight databases,
five project-owned volumes and three saved keys with zero ACP Sessions or Runs.
Private evidence retains both recovery plans, original storage fingerprints and
replacement PostgreSQL identity. Original execution, archival and cleanup errors
remain failures; failed Docker cleanup retains the private recovery inputs.

Set `ANTNEST_E2E_CONTROLLER_IMAGE=<image-or-immutable-ID>` or
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE=<image-or-immutable-ID>` to test a
specific Agent Controller or Runtime Controller image. Deployment checks compare
the actual image IDs. The defaults are `antnest/agent-controller:local` and
`antnest/runtime-controller:local`. All profiles except the crash profile read
these options through their shared Compose override.

## Isolation

- Each run chooses unused ports and network ranges and creates one isolated
  Compose project. One PostgreSQL instance hosts the service-owned databases.
- Administrator and Provider data are synthetic. A local deterministic model
  serves prompts; no external model is called and `.secret` is never loaded.
  The model's control port binds to loopback only.
- The run never replaces a retained development stack and never keeps a stack
  after failure. Runtime creators stop before cleanup, and every test-owned
  container, volume and network must be gone before a passing summary prints.
- Every Docker command has a deadline, and its process group is killed on
  timeout. A failed or partial run is not evidence.
- Evidence goes under `artifacts/verification/lifecycle-<profile>/<project>/`,
  which is excluded from Git. The runner validates the evidence path before any
  Docker or network discovery and rejects cache aliases, including dangling
  links. Raw reports are private regular files; `.cache` is never used.

## Trace Checks

Lifecycle traces must bind the Gateway and Console admission and the request ID
to the Temporal workflow, its activities, committed driver writes and the
identified Runtime and Egress mutations. Drain includes ACP snapshot publication
and the matching settlement acknowledgement. ACP Runs have their own message
traces and do not acquire Controller admissions.

The legacy diagnostic inspectors check topology and convergence across three
samples. They retain failures, warnings and strict exit codes in the evidence.
Default Foundation and Runtime Loss treat these results as auxiliary under one shared 60-second
collection budget; its business and cleanup admission is described below.
Supplied passwords, model keys and session
cookies must not appear in any span; RPC content capture is disabled. A span
that was never exported because its process was killed is reported as a gap,
never replaced by a fabricated span.

Normal Console lifecycle admission and HTTP Create replay additionally validate
the `console` Resolve source before the actual Gateway-to-Console CLIENT.
Current, shared-source and refresh-trigger traces are archived by Trace ID and
must converge across three complete snapshots. The exact Resolve RPC receipt
must have successful CLIENT, SERVER and owning SQL evidence; cached admission
does not replace Controller owner authorization or committed business writes.
Create replay still requires its one read-only transaction with no work dispatch.
The owning inspector is awaited, and its strict verdict and full source
diagnostics are both retained. Source errors cannot inherit clock-only or
workflow-restart diagnostic exceptions. Clock-only acceptance requires zero raw
errors; a restart exception requires the exact reviewed total.

The shutdown ACP request collector selects
the actual message using its observed connection and request
identity, then validate the `acp` Resolve source. They retain the owning Run,
model phase, durable-write and rejection checks. Selection records the actual
Trace ID before admission can fail, and the complete current/source/trigger
closure is archived and converges over three snapshots. Raw source diagnostics
remain in the strict result. Cancellation waits for active
collection and the owning inspector to finish.

Default Foundation delegates the original owner's member Session and Principal
through Identity and uses private ACP v1. The actual upgrade CLIENT, connection
and dispatched wire request select every initialize and business Trace. Both
closed connections retain their original SDK results, raw responses and updates;
the held Prompt and two busy probes remain concurrent on the first connection.
Trace collection, topology, timing and exporter results remain private diagnostics.
They do not determine default Foundation's exit code. The original two Runs and
Tools, four Provider requests, busy denials, lifecycle receipts and SQL observations
are validated independently. Collector cancellation waits for the actual callback
to finish; exporter shutdown is always awaited even after the collection budget
expires. Other Lifecycle consumers remain separate migration work.

Controller-root Runtime observation and Identity offboarding keep their own
admission paths. The opt-in killed-process crash collector validates the original
Console admission through its existing verified recovery projection, preserving
the complete raw current/source/trigger closure and its failed strict verdict.
External sources receive no crash exception. See the
[crash Trace rules](crash-contract.md#trace-rules). Shutdown watches have their
own cancellation gate; network policy writes use their separate PUT/200 gate.
Cross-service #59 Docker/HTTPS admission remains pending.

## Foundation

The foundation profile verifies:

1. An empty instance, a model, a Template, an active owner and a ready Agent,
   all set up through Gateway.
2. Create, rebuild, disable, enable and delete reach a durable terminal state.
   Replaying each exact request key returns the same operation without repeating
   effects.
3. Publishing a Template leaves existing configuration and the physical
   container unchanged. An explicit rebuild changes compute but preserves
   workspace bytes. Disable removes compute and keeps the bytes; enable reuses
   them. Delete removes both, hides the Agent and retains events and operations.
4. Network assignment GET, CAS, replay and conflict through Console, including
   policy changes while disabled. Assignment acknowledgement does not prove TUN
   packet flow; the network profile covers that.
5. Paginated global-cursor event replay, and a Controller restart after terminal
   operations, preserve the journal and request identity.
6. All Compose services, including Temporal, are running and healthy. The
   application containers use the locally built image IDs. Gateway, PostgreSQL,
   Jaeger and the model publish loopback ports. Default Foundation additionally
   exposes private ACP and Identity through the diagnostic relay and a dedicated
   client telemetry receiver, all on dynamic loopback ports. The host reads only
   the inner project's gateway-identity and agent-ui-acp workload grants.
   Temporal stays private, and dynamic network allocation excludes reserved
   Runtime infrastructure addresses. Other profiles keep their original Compose
   boundary.

### Runtime-start failure

A Template requires a managed MCP command that is missing from the Runtime image.
Creation completes its durable provisioning phases, while the Runtime separately
becomes unhealthy or exits without an executable binding. The test correlates
the owned container's logs with the Agent, generation and the missing MCP so an
unrelated fault cannot satisfy it. Replaying the create request changes nothing.
Delete removes compute and workspace, and the completed operations and events
survive an idle worker restart. A failed Runtime is not reported as a failed
provisioning operation.

### Active Run and rebuild

The model makes the owner's ACP v1 prompt run a real Runtime `bash` tool that
writes a start marker and waits on a file barrier. While the tool runs, a new
Template revision is published and a rebuild is admitted through Gateway. The
test requires:

- durable `running/drain`, the original executable binding and container, an
  open network attachment, and only the first workspace effect;
- a second Session prompt rejected with `agent_busy` (`-32030`, retryable,
  `retry_after_ms=1000`),
  with no updates, Run intent, model request or tool dispatch;
- a graceful Agent Controller stop and start during drain, with exit code zero
  and no OOM. The ACP service, Runtime, shell PID and pending prompt survive;
- after the barrier is released, the held Run completes before the Runtime is
  replaced. Loading the same Session shows the new Template guidance and an
  environment-rebuild notice, and a real `read` returns both workspace effects
  without replaying the old tool.

This profile covers a graceful restart. It does not claim SIGKILL recovery.
Worker Span endings and the Trace projection of both drain attempts are retained
as auxiliary diagnostics.

Admission requires two initialized and fully joined connections, seven business
requests (`new`, `new`, held Prompt, two busy Prompts, reconnect `load`, fresh
Prompt), two distinct completed Runs, four original Provider calls and two real
Runtime Tools. The complete private ACP state response, including
`configuration_revision`, proves drain publication; no retired Gateway state
route or browser projection substitutes for it. The original `allow_once`
permission response and 180-second held / 60-second fresh Prompt budgets remain.
Parent cancellation closes the socket and joins pending requests and archives;
business, original cancellation, archival and cleanup errors are preserved.

The two Session audit pages and both Run detail/event pages are retained as six
original responses, alongside complete model records and both busy before/after
checkpoints. Partial originals survive a read or business-validation failure.
The nine lifecycle admissions (three create, one rebuild, one disable, one
enable, three delete) bind their original operation IDs and terminal results.
The failed-Runtime Create still completes provisioning. Its exact replay and
every independent Runtime observation retain hard history and SQL provenance
checks. Distinct observation events are counted independently of Trace roots.
Raw business inputs and lifecycle requests are excluded from the public summary.
Exit 0 is written only after business checks, private connection/work/exporter
joins and actual Docker cleanup; missing business evidence cannot be accepted
because diagnostic collection failed or a child exited 2.

## Whole-Platform Stream Shutdown

The profile builds fresh candidate images, creates an idle Agent and holds three
connections open: the administrator lifecycle event watch, the owner's private
ACP execution-state watch and an initialized private ACP v1 WebSocket with an
empty Session. The same original member Session and Principal authorize both
connections and both state watches across restart. It stops the application
services with ordinary Compose SIGTERM, without closing clients first. Every
service must exit zero without OOM or forced termination, and the remote ends
must close the watches and WebSocket. Temporal stops before PostgreSQL.

The SSE observer preserves its first closure cause, actual response Trace ID,
observation time and delivered-event count in an immutable record. Test-owned
close, global abort and invalid responses or events have separate causes;
subsequent cleanup cannot relabel them as a remote transport end. A remote end
also clears the reconnect timer that EventSource creates after its error callback.
Gateway's cancelled proxy may close the socket without a terminal HTTP chunk.
The observer retains that exact original body-termination Error separately;
final admission requires its valid initial event, original Trace, stop window,
clean Gateway exit and cancellation spans. Independent read, cancel, archive
and parent-cancellation failures still fail the run.
The public watch collector validates `console` event-watch Resolve admission
before its actual forwarding CLIENT. Every successful
revalidation proves its `rpc/cache/shared` source; linked sources and refresh
triggers are archived and must converge over three complete raw snapshots.
Pending shutdown cancellation has its own non-admission evidence, including the
actual stop operation, the same cleanly exited Gateway container and remote
closure. Source errors remain strict failures and cannot inherit the current
watch's cancellation classification. See the
[shutdown Trace rules](shutdown-migration-contract.md#trace-rules) for timing,
concurrency and unavailable-result limits.

The private state watch posts to ACP with a delegated credential and retains its
actual exported CLIENT, full raw SSE body and first remote EOF. Its SERVER and
database work must belong to the original ACP process and end before that process
exits. Only the exact `agent.execution_state` process-shutdown error is admitted;
the original error and strict failure remain in evidence. All watch fetches,
readers, cancellation, ACP connections and exporters are joined before teardown.

Final admission requires two initializations, `new` and `load` of the same empty
Session, two lifecycle operations, both remote watch closures and the original
remote WebSocket close receipt. It rechecks the eleven stopped and restarted
container identities, both Temporal membership observations, unchanged Runtime
and workspace bytes, empty audits/model requests and complete Delete. Partial
business, collection, archive and cleanup errors remain private and fail admission.

An HTTP stream cancelled by shutdown may end as `handler_aborted` only when the
span also carries `antnest.http.request_cancelled=true`, keeps HTTP 200 and ends
inside the stop window. These spans are still reported as strict failures.
Other dependency errors and unclassified aborts fail the run.

Restart starts the same containers in dependency order without rerunning schema
jobs. The same Agent, workspace and ACP Session must remain; loading the Session
makes no Run or model call. Session metadata and the event journal are
unchanged, and new watches receive the same history. The Runtime container is
not managed by Compose and must keep running. This profile tests idle-stream
maintenance, not killing an active Tool.

## Offline Backup and Restore

The profile disables its Agent, stops application writers and then Temporal, and
exports seven databases, workspace and system Skill archives and three
encryption keys. It checks inventory, checksums and ownership before replacing
only owned storage. Roles and empty databases are created before data is
restored. Schema initializers and writers wait until row, sequence, ownership
and ACL fingerprints and the file archives match.

Public audit and Agent event history must survive. Replaying a Session makes no
model call or new Run. A prompt on an untouched restored Session uses its saved
encrypted MCP revision and runs one new Tool Run. See the
[backup and restore procedure](../../../docs/docker-backup-restore.md).

Default Restore runs through the fresh-image authenticated wrapper and delegates
the original member Session through private ACP v1. After storage recovery it
requires the original second login with the same Principal and a distinct
Session, then binds that Session to the second connection. Its two initialize
and six business requests retain the actual SDK wire receipts, two public Runs,
four Provider requests and Bash/read calls. The untouched Session is never
loaded before its first post-restore Prompt. The pre-restore model inventory is
saved before recreating the model process.

All pre-restore connections close and join before writer shutdown. Raw inspect
receipts prove the relay, host telemetry receiver and Jaeger keep their identity,
start time and endpoints across storage replacement. Eight request collections
and four lifecycle collections preserve independent failures; exporter and
temporary-directory cleanup errors remain failures. Private evidence is archived
before final admission and excluded from the public summary. Strict diagnostics
remain separate from admission, with no semantic-denial allowance.

`make e2e-stage4-skill-restore` uses its own fresh-image private ACP consumer and
admission. Four connections delegate the two original login Sessions in order
0/1/1/1 and retain four initializations, ten business requests, four Runs, eight
Provider calls, one Bash and three read calls. Nine completed lifecycle
operations belong to the two Agents. Registry stops after recovery; both Agents
must reuse their independent pinned v1 Skill volumes. The complete eight-database
recovery plan includes all current/lifecycle/set Skill volumes, not only mounts.

The missing-volume Enable is separate from those nine operations. Its original
five-second timeout Error or raw HTTP 503 receipt is kept with all same-key
preparation queries. Admission binds the organization/key-derived request to
`enable/retry_wait/skill_preparation_unavailable`, a disabled Agent, zero Runtime
containers, only the original workspace and no recreated Skill volume. A new
real read on the unaffected Agent and both Deletes must still complete. Raw
failure, Registry inspect and original Skill file receipts remain private.
The independent eight-database/five-volume storage suite is a separate gate.

## Runtime Health and Observation

The profile checks Engine health, Runtime Controller's Runtime state and ACP
execution availability independently. It keeps two 60-second idle CPU samples,
fast startup probes and the steady 10-second, three-failure health policy.

Only the test-owned Runtime is paused with SIGSTOP. After three failed checks,
Controller must report it unhealthy and ACP must report it offline. An
independent cleanup client always sends SIGCONT. Recovery in the same process
keeps its execution identity and workspace. A normal stop and start proves that
a new process cannot reuse the old executable binding. An explicit rebuild
restores availability with the same workspace and new revisions. No Run or
model call is allowed.

`make e2e-lifecycle-health` builds fresh scoped candidate images and validates
the original fifteen-service deployment and Runtime image. Its Health-only
relay publishes two additional loopback ports for Identity and private ACP
state; it opens no ACP protocol connection. Each read delegates the original
member Session/Principal, validates the complete state contract, and retains
the raw response privately. The whole Identity and ACP read has a 15-second
budget clipped to the remaining original 60-second convergence window.
Five distinct confirmations bind unhealthy, same-process recovery, and three
post-restart observations to their actual Agent snapshots. Public output omits
raw state. Cleanup joins pending reads and preserves both original and cleanup
failures. Admission keeps the three lifecycle operations and zero Run/model
inventory, retaining strict diagnostics under the existing lifecycle review
policy. Other Lifecycle consumers remain separate delivery batches.

## Interrupted Runtime Update

A transparent HTTP fixture holds one Agent's completed Runtime Update response.
At the checkpoint Agent Controller is still in `running/runtime_update` with no
result, and the Runtime child is committed with its target present. No response
is fabricated.

Both Controllers stop normally, Agent Controller first, and exit zero. The
fixture must record caller cancellation, not expiry. After restart, Temporal
retries the same Activity and reuses the same terminal child response and target,
with no new mutation, generation, workspace replacement or duplicate event.
A rebuild then selects a new Template revision with a changed request budget and
keeps the remaining configuration and workspace bytes. This profile covers a
lost committed response with normal stops; crash recovery of an unfinished
Runtime mutation is covered by the opt-in crash profile.

## Runtime Network Policy

Two Agents run real ACP v1 prompts that execute Runtime `bash` as UID/GID 1000
and open raw TCP connections. The target is an isolated TCP fixture on the
Egress test network only. A scoped route in the disposable Egress namespace
preserves the synthetic public destination `1.1.1.1:18080` through the production
policy and kernel gates. A fail-closed forwarding guard permits only this
fixture destination. No host route, host firewall or production policy rule
changes, and no Internet endpoint is used.

The original member Session and Principal delegate six private v1 connections;
each initializes once, creates one Session and runs one Bash Prompt. All six
initialize and twelve business requests retain raw wire receipts and independent
Trace evidence. The two held Prompts stay concurrent across deny and stale CAS.
The fresh candidate-image wrapper checks seventeen services and the original
nine application images, including the confined host telemetry receiver.

The test requires:

- allow, then deny, then allow on Agent A while Agent B stays allowed;
- after A's deny acknowledgement, A's existing conntrack entry is gone while B's
  remains. A does not receive pushed data and its next write is rejected
  promptly; B continues on the same socket;
- denials appear as prompt connection rejection or reset, never as a timeout.
  DNS denial needs both a bounded resolver error and a direct TCP rejection to
  the configured resolver; B still resolves the target;
- policy updates and replay never change the Runtime container, generation,
  start time, workspace or executable configuration;
- policy-write traces follow Gateway, Console, Agent Controller and Egress.
  Prompt, model and tool spans stop at Runtime; there is no per-packet tracing.

The four recorded successful policy PUTs validate `console` Resolve admission
before the actual Gateway CLIENT forwards to the Console SERVER. The Egress
write must descend from that same Console request and retain the existing Agent,
route, success and error checks. Current, shared-source and refresh-trigger
traces are archived and converge over three complete snapshots; raw source
errors and warnings remain strict failures. The collector uses the caller's
abort signal and waits for active requests and response bodies. The existing
409 and idempotent-replay business assertions are unchanged; these requests do
not acquire additional Trace coverage through this adapter. Their actual 409
and exact replay receipts remain part of private admission. Six public Run IDs,
twelve phase-bound Provider requests, six Bash calls, four successful policy
writes and four lifecycle operations must all agree with the original wire
inventory. Clients, pending Prompts and telemetry are fully joined; independent
collection continues and original collection/archive/cleanup errors remain
available together. Public summaries exclude raw request and identity bodies.
Reviewed external SDK/clock diagnostics keep their strict status and raw spans;
unknown internal diagnostics still fail admission.

## Unplanned Runtime Loss

The current Loss admission uses complete original Admin Run/detail/event pages,
SDK replies and replay/denial checkpoints independently of Trace. Four completed
Runs and durable Tools, eight model requests, private offline state, six completed
lifecycle operations, physical Runtime removal/replacement and workspace checks
remain required. Request, lifecycle and strict Trace collectors share one
60-second auxiliary budget. Original findings and unavailable collections are
retained; actual seven-service stops and resource joins remain hard requirements.

Organization scope comes from the original login, creation principal and
authenticated requests. Public Agent and Run projections bind the owner, Agent,
Session, spec and execution revision. Captured container IDs, scope/Agent labels,
public Runtime revisions and workspace volumes establish replacement lineage;
the real flow separately verifies physical Runtime and SQL observations.

Two Agents each complete a real Bash append before their idle Runtime is
stopped and removed without force.

The original member Session and Principal delegate six private v1 connections,
with six initializations and fourteen business requests. All twenty requests
retain their actual wire receipts and private CLIENT/upgrade/Session lineage.
The second connection in each case remains open through Runtime removal and a
complete private execution-state observation. The fresh candidate-image wrapper
verifies sixteen raw services, the fifteen-service Foundation projection and
nine application images.

- In the live case, Controller observes the exit before removal and the Runtime
  journal records `runtime_deleted / docker_event`.
- In the cold case, Runtime Controller stops before removal and on restart
  records `runtime_missing / platform_reconciliation`.

Loss events have an `event_<32 lowercase hex>` identity; see the
[resource ID contract](../../../contracts/resource-identifiers.md). ACP state
becomes offline and prompts fail with the negotiated `agent_unavailable` error without
notifications, model calls or new Runs. An explicit rebuild with the same
Template revision restores the Agent with new compute and Runtime identity and
the same configuration and workspace. A real `read` returns the original bytes,
and the model sees a reset notice. Another normal Runtime Controller restart
keeps the replacement and the loss history.

Final admission binds the four public Run audits, eight phase-bound Provider
requests, two Bash and two read calls, and six lifecycle admissions to their
original Agent and Session. Missing-source Rebuild requires the observed old
generation's absent Inspect followed by next-generation allocation and start.
The expected Docker 404 remains an absent observation; historical 404 ERROR
evidence is retained and receives no new exception. Every client and exporter
is joined before its receiver stops. Independent request and lifecycle
collection continues after a sibling failure, preserving original business,
archive and cleanup errors together. Raw private wire and state bodies stay out
of public summaries. Strict failed diagnostics are retained separately from
business admission; unknown internal diagnostics still fail.

## Runtime Reconstruction Crash

`make e2e-lifecycle-crash` is opt-in and runs separately. It kills only the
disposable Runtime Controller at real Docker mutation boundaries while Agent
Controller and Temporal stay alive. It then checks immutable retries, workspace
retention and single publication. The diagnostic target can exit 2 for strict
timing warnings. See [crash-contract.md](crash-contract.md).
