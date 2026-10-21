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
Configuration must not run a model, Tool or permission approval. The actual
Docker client collects these checks with the rest of its request inventory.

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
The shell invokes the owning private host deployment. Both the normal business
run and the independent crash cleanup have passed actual Docker acceptance.

The owning candidate image plan uses this run's `permission-UUID` tags for ten
services, the production Runtime base, the official managed fixture carrier and
the final Runtime image. The final fixture COPY always runs, including with CI
provided source images. Original production layers and configuration, both
source identities around COPY, tag ownership and captured image IDs are checked.
Interrupted or failed builds clean only their recorded candidates in reverse
order. The root shell selects the admission overlay and builds and cleans this
plan; CI supplies the production and fixture source images. The normal and crash
Docker runs built and inspected their own candidates from the current sources.

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
Controlled command and filesystem tests establish this host contract. The child shell preserves
client exits 0/2/137 only after successful host checks and independent cleanup.
Host failure enters cleanup immediately. Cleanup has its own ten-minute budget;
its failure still exits 1, and the parent subsequently removes owned stack resources.

The actual normal run passed all 26 scenarios with 52 Model requests and 64
unique Traces, each archived with three complete stable source samples. Both
Runtime inspections matched the original ACK consumed before the two completed
Agent deletions. Its raw strict diagnostics and exit 2 remain recorded; confirmed
external SDK issues are non-blocking. The separate crash run reached its first
pending approval, joined the killed client with exit 137 and no OOM or Runtime
ACK, then completed independent cleanup of the one created Agent. Both runs
restored the original Docker container, network, volume and image inventories.
These results cover this consumer; browser capacity and full cross-service
integration remain separate acceptance work.

## Running

```sh
make test-permission-fixtures
make e2e-tool-permissions
```

`make e2e-tool-permissions` builds this invocation's service and Runtime
candidates from the current sources. CI may supply the production Runtime and
official managed MCP fixture carrier as local input images; the final fixture
COPY and source/layer/configuration checks still run. This enables unannotated
Smart Approve calls while builtin Tools use the production Runtime implementation.
The driver does not require a separately prebuilt `managed-integration` image.

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
Smart judgments, on the expected Model for every phase. Original SDK receipts,
complete Admin Run lists and execution/permission pages independently verify
26 Runs, sixteen executed Tools, sixteen persisted permission waits and eighteen
approval deliveries. Each Run binds to its original ready Agent and Runtime.
Rejection, cancellation, replay and reconnect must retain their original outcomes
and must not introduce model calls or execution. Real Runtime acknowledgement,
Agent deletion and final operation completion remain hard gates.

Trace collection, topology, timing and exporter failures are auxiliary under one
shared 60-second budget. Missing or malformed diagnostic identities do not waive
business checks or fabricate evidence. Raw diagnostic failures and unexecuted
collections are recorded explicitly. The client reports business success only
after its resource wrapper has finished the actual shutdown and connection joins.

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
