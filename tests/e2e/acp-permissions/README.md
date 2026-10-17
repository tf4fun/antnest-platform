# ACP Tool permission E2E

This scenario verifies Tool permission modes, approval decisions and pending
approval recovery through the deployed ACP service on a disposable full stack.

## Private transport migration

The owning `openPrivatePermissionConnection` adapter now delegates the original
browser Principal through Identity to private v1/v2 WebSocket ACP. It records
the actual initialize and business request IDs, inputs and successful replies,
and keeps permission delivery IDs, original parameters and decisions separately.
Pending decisions accept only an offered option, settle once, and settle as
cancelled when the request signal aborts. Snapshot mutation cannot alter the
original decision. Closing joins requests and decisions and checks both wire
inventories; cleanup errors remain failures.

For the scripted reconnect case, v1 requires the original outstanding prompt's
local close error with no reply. A completed v1 prompt cannot acquire that
exception. V2 requires the actual completed prompt `messageId` acknowledgement;
an acknowledgement does not settle its pending approval. Other business requests
cannot overlap that pending decision, while a cancel notification can be sent.

The owning configuration Trace inspector binds the original request ID,
Session, `mode` or `model` selection and returned value. It checks the complete
authorized Session/configuration reads, revision-checked update and visible
configuration message in one committed transaction. A complete output read
must precede configuration mutation; later output reads remain allowed. SQL
values are not exported, so the observed selection comes from the actual SDK
receipt. Grouped model choices and additional thinking options remain intact.
Configuration must not run a model, Tool or permission approval. These Trace
fixture checks still require actual consumer collection and Docker acceptance.

The actual client now uses this adapter, retains each login Principal, joins
connections and telemetry, and keeps both business and cleanup failures. V1
reconnection accepts only the original unanswered prompt's local close; v2
keeps its actual acknowledgement and still waits for the resumed terminal state.
Both versions compare the complete original and reissued approval parameters.
Cancellation preserves the original prompt rejection, including when connection
cleanup also fails; a v2 acknowledgement still requires its terminal update.

The client inventories six connections and initializations, 56 business RPCs,
two original cancel-notification receipts and 18 permission deliveries. Requests
are bound by connection and actual request ID; failed calls retain their inputs
without acquiring a success receipt. The 26 prompt phases retain their Provider
Trace and actual approval deliveries, including both connection identities for
replay. A thin collector reuses the shared raw archive and three complete stable
source samples for all 64 request/notification Traces.

The private prompt inspector binds approval Tool IDs to the original Run and
Provider call, and checks the completed/cancelled Run's quiescence and effect
state. It retains full raw error diagnostics and allows only the exact deliberate
permission rejection or original v1 closed-response dispatch failure. SDK end
timestamp overlap does not block this consumer; raw diagnostics remain intact.
The `permission_decided` record is a service stdout log, not a Span event; the
inspector does not claim to read its decision or database parameter values.

The Runtime inspector checks the complete parsed information read, discovery
and catalogue exchanges, and each actual write/read executor or managed echo
stdio call. Chat has no catalogue access; rejected, cancelled and Chat phases
have no Tool execution. Original Agent, Session, pinned execution, generation
and process ownership remain required. A separate v1 completion refresh binds
its own current execution and cannot replace the Run preparation. Only exact
completed-connection cleanup fields receive the existing diagnostic treatment;
unknown work and internal errors remain failures.

Local fixture and real TCP adapter checks establish these contracts. The client
now waits for the host's exact two-Agent Runtime inventory before deleting its
Agents. The original ACK bytes, candidate image identity, container IDs,
generations and original starts are bound to this project, run and nonce. Both
complete delete responses and completed operations are retained in sequence on
the client clock after ACK consumption. Business, deletion and evidence failures
remain failures, and cleanup still attempts every created Agent.

The independent cleanup entry now delegates the original owner's login Principal
to private v1 ACP. It awaits each paged Session close reply, joins the connection
and telemetry, and keeps its requests outside the 64 business Trace inventory.
Controlled Identity and actual SDK/TCP checks cover delegation, pagination,
failures and cleanup; they do not replace production authorization or Docker.
Shell deployment wiring and actual Docker business acceptance remain pending.
The current shell runner is not yet an accepted retired-route-free scenario.

The owning candidate image plan uses this run's `permission-UUID` tags for ten
services, the production Runtime base, the official managed fixture carrier and
the final Runtime image. The final fixture COPY always runs, including with CI
provided source images. Original production layers and configuration, both
source identities around COPY, tag ownership and captured image IDs are checked.
Interrupted or failed builds clean only their recorded candidates in reverse
order. These controlled image-command tests do not constitute actual builds or
host deployment acceptance; the shell integration remains pending.

The owning host module imports this image plan and checks the actual stack.
It precreates the model, independent cleanup container and then business client,
recording each original container ID before inspection. All three use the
candidate ACP image as the service-auth user. Client and cleanup receive only
two read-only grants, exact private listener pins, individual read-only contract
files and writable `traces`/`deployment` subdirectories; the model has no grants.
Inspection also checks the actual networks and model aliases.

While waiting for the client, the host checks the original container identities
and start times. It saves the complete two-Runtime inspection before publishing
an ACK with the exact raw SHA, Agent IDs, image ID, generation and `StartedAt`.
The optional browser pause stays within the overall deadline. The crash control
recognizes only the complete `crash_ready` JSON record, kills and joins the
original client, requires exit 137 without OOM, and publishes no Runtime ACK.

Host cleanup first joins and removes the business client, then starts and waits
for the independent cleaner, retaining the model until cleanup diagnostics are
saved. Nonzero cleaner exits, inspection and evidence errors remain failures;
other owned removals are still attempted. Recovery uses only original create
IDs or a unique project/run/role match, and refuses foreign or ambiguous owners.
Controlled command and filesystem tests establish this host contract. Actual
Docker, the shell/CI connection and the independent crash run remain pending.

## Running

```sh
make test-permission-fixtures
make e2e-tool-permissions
```

`make e2e-tool-permissions` needs the current local service images
(`make docker-build-stage3`) and the `antnest/antnest-runtime:managed-integration`
image. That image adds the official SDK managed MCP fixture to the production
Runtime for unannotated Smart Approve calls; all builtin Tools still use the
ordinary Runtime implementation. See [managed MCP](../managed-mcp/README.md) for
how the image is built.

The root driver creates an isolated Compose project with temporary ports,
non-overlapping networks, synthetic credentials and RPC content capture
disabled. The permission wrapper refuses direct invocation without that
disposable owner. No existing development stack or external model Provider is
used. Provider connections publish two Models; Templates use the stable default
Model identity, and Agents use the returned Template revision and the current
readiness contract.

## Scenarios

The test covers 26 v1 and v2 scenarios: allow and reject, once and always,
cached decisions, Chat, Approve and Smart modes, per-Session model selection,
builtin read-only hints, exact-call Smart judgments, cancellation, and pending
approval recovery after reconnection. It checks both wire formats for Tool
updates before approval, requires unchanged approval parameters after
reconnect, and checks the terminal v2 state and stop reason. Smart judge text
must stay out of the chat.

The deterministic model must receive exactly 52 requests, including four hidden
Smart judgments, on the expected Model for every phase. Each prompt Trace
correlates the model HTTP CLIENT spans to ACP-owned Runs, committed persistence,
fresh Runtime preparation and the permission outcome. Every approval wait must
precede its permitted dispatch; rejected, cancelled and Chat Runs must have no
Tool effect. Runtime SERVER and Tool ancestry and Run IDs are required for every
effect. Two reconnect request Traces prove that load and resume do not execute a
second Run, and two foreign-user denials require the specific ACP access error
with no private updates or execution. The v1 reconnect prompt closes its socket
before the answer, so only that ACP prompt span may record the failed response
dispatch.

Topology and secret-boundary results are reported separately from strict Jaeger
timing. Timing warnings alone exit 2; any other failure exits 1. The fixture
does not synchronize clocks, rewrite timestamps or waive unrelated diagnostics.

## Optional modes

- `ANTNEST_E2E_BROWSER=true make e2e-tool-permissions` pauses with a synthetic
  owner and Agent before teardown so the UI can be inspected manually. The
  client's `browser_ready` record contains the account and Agent. Release the
  pause with the fixture's `POST /release-ui`. Browser interactions are not part
  of the automated protocol result.
- `ANTNEST_E2E_PERMISSION_CRASH=true make e2e-tool-permissions` deliberately
  kills the client at its first pending approval. Expect client exit 137 (Make
  exit 2) and a successful independent Agent cleanup record. This is a cleanup
  negative control, not a passing protocol run.

## Cleanup

After consuming the original host Runtime ACK, the client deletes both Agents
through the Gateway and Controller and waits for both operations before Trace
collection, so Runtime shutdown flushes OTLP. Failure paths attempt every created
Agent while preserving the original business and cleanup errors. Independent
wrapper cleanup discovers only this invocation's UUID-qualified Agents, closes
their Sessions through private ACP and deletes them through the Gateway and
Controller, even after the client is lost. It bounds Session pagination at 100
pages and rejects repeated cursors. A Session close failure still attempts that
owned Agent's deletion and remains a failure. Public output uses the shared safe
failure summary; original errors and failure inventory stay in private evidence.
The independent entry always uses an `independent-cleanup/` subdirectory so its
failure files cannot overwrite the business client's original failure files.
Every fresh Agent detail, including after an active operation, must retain the
selected Agent ID and this run's exact name before cancellation or deletion.
It attempts every owned Agent and reports partial failure. The
root owner then stops resource creators, removes Compose and Runtime resources
under both scope labels, and checks for leftovers, including volumes and
identity and catalog data. A control-plane cleanup failure stays visible even
when Docker cleanup succeeds. If the root owner itself is killed, automatic
cleanup cannot be guaranteed; inspect both the project and Runtime scope labels.
