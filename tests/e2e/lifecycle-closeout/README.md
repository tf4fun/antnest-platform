# Lifecycle Closeout

These disposable Docker profiles test Agent lifecycle end to end: create,
rebuild, disable, enable and delete, plus shutdown, health, backup and restore,
interrupted updates, network policy and Runtime loss. Every business command
enters through Edge Gateway and Admin Console. Agent Controller runs all
lifecycle operations as Temporal workflows. PostgreSQL stores business phases
and results, not worker leases or attempt counters.

Docker inspection is used only as independent physical evidence and to place
or read a synthetic workspace sentinel. It never updates service databases or
fabricates lifecycle outcomes.

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

| Target | Profile | Contract |
| --- | --- | --- |
| `make e2e-lifecycle` | Foundation, including the active-Run drain | [migration-contract.md](migration-contract.md) |
| `make e2e-lifecycle-shutdown` | Whole-platform stream shutdown and restart | [shutdown-migration-contract.md](shutdown-migration-contract.md) |
| `make e2e-lifecycle-health` | Runtime health and observation | [health-migration-contract.md](health-migration-contract.md) |
| `make e2e-lifecycle-restore` | Offline backup and restore | [restore-migration-contract.md](restore-migration-contract.md) |
| `make e2e-lifecycle-interrupted` | Interrupted Runtime update with a lost committed response | [interrupted-migration-contract.md](interrupted-migration-contract.md) |
| `make e2e-lifecycle-network` | Runtime network policy on the real packet path | [network-migration-contract.md](network-migration-contract.md) |
| `make e2e-lifecycle-loss` | Unplanned Runtime loss, live and cold | [loss-migration-contract.md](loss-migration-contract.md) |
| `make e2e-lifecycle-crash` | Opt-in Runtime Controller crash during reconstruction | [crash-contract.md](crash-contract.md) |

The workspace protocol profile reuses the same Foundation runner; see
[its contract](../workspace-closeout/protocol-migration-contract.md).

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

Completed traces must pass topology checks and converge across three samples.
A topology failure exits 1. Raw warnings and error spans stay in the evidence
and make the strict result exit 2. Supplied passwords, model keys and session
cookies must not appear in any span; RPC content capture is disabled. A span
that was never exported because its process was killed is reported as a gap,
never replaced by a fabricated span.

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
   application containers use the locally built image IDs. Only Gateway,
   PostgreSQL, Jaeger and the model publish loopback ports. Temporal stays
   private, and dynamic network allocation excludes reserved Runtime
   infrastructure addresses.

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
- a second Session prompt rejected with `agent_busy` (`-32020`, nonretryable),
  with no updates, Run intent, model request or tool dispatch;
- a graceful Agent Controller stop and start during drain, with exit code zero
  and no OOM. The ACP service, Runtime, shell PID and pending prompt survive;
- the stopped worker's Workflow span ends with `worker_shutdown` and the
  replacement's with `workflow_return`, and both drain attempts use the same
  acknowledged ACP snapshot revision;
- after the barrier is released, the held Run completes before the Runtime is
  replaced. Loading the same Session shows the new Template guidance and an
  environment-rebuild notice, and a real `read` returns both workspace effects
  without replaying the old tool.

This profile covers a graceful restart. It does not claim SIGKILL recovery.

## Whole-Platform Stream Shutdown

The profile creates an idle Agent and holds three connections open: the
administrator lifecycle event watch, the owner's workspace state watch and an
initialized ACP v1 WebSocket with an empty Session. It stops the application
services with ordinary Compose SIGTERM, without closing clients first. Every
service must exit zero without OOM or forced termination, and the remote ends
must close the watches and WebSocket. Temporal stops before PostgreSQL.

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
Egress test network only. A test-only DNAT rule in the disposable Egress
namespace maps `1.1.1.1:18080` from its TUN to the fixture. The Rust policy still
evaluates the original external address before writing to the TUN. A fail-closed
forwarding guard ensures that losing the DNAT rule never sends traffic to the
Internet. No host route, host firewall or production policy rule changes.

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

## Unplanned Runtime Loss

Two Agents each complete a real Bash append before their idle Runtime is
stopped and removed without force.

- In the live case, Controller observes the exit before removal and the Runtime
  journal records `runtime_deleted / docker_event`.
- In the cold case, Runtime Controller stops before removal and on restart
  records `runtime_missing / platform_reconciliation`.

Loss events have an `event_<32 lowercase hex>` identity; see the
[resource ID contract](../../../contracts/resource-identifiers.md). ACP state
becomes offline and prompts fail with `-32020/agent_unavailable` without
notifications, model calls or new Runs. An explicit rebuild with the same
Template revision restores the Agent with new compute and Runtime identity and
the same configuration and workspace. A real `read` returns the original bytes,
and the model sees a reset notice. Another normal Runtime Controller restart
keeps the replacement and the loss history.

## Runtime Reconstruction Crash

`make e2e-lifecycle-crash` is opt-in and runs separately. It kills only the
disposable Runtime Controller at real Docker mutation boundaries while Agent
Controller and Temporal stay alive. It then checks immutable retries, workspace
retention and single publication. The diagnostic target can exit 2 for strict
timing warnings. See [crash-contract.md](crash-contract.md).
