# Local Execution Configuration

## Ordered Provider Fallback

The [shared availability contract](../../../docs/provider-failover.md) adds ordered
Agent `fallback_model_profile_ids` after `default_model_profile_id`. ACP owns
effective Session/Run selection; Controller readiness does not decide model
availability. Manual selection remains organization-scoped. A missing available
candidate rejects prompting, not Session history or configuration access.

Provider disable/revocation fails existing holders without graceful draining or
Run replay. Re-enable creates new holders; credential rotation alone does not
cancel execution. Platform publications refresh current ACP configuration options
without adding synthetic model replies to the transcript. OpenRouter uses the
OpenAI-compatible transport without DeepSeek-specific thinking parameters.

The owning cross-service design is the
[Controller/ACP boundary plan](../../../docs/controller-acp-execution-boundary-plan.md).
The [internal contract](../../../contracts/agent-acp/execution-api.md) is not an
ACP extension. Controller production publication and Gateway/Console integration
are complete within the [B5 acceptance scope](../../../docs/current-status.md).
The service-local evidence below retains its original scope; strict clock-warning
failures remain separately recorded.

## Configuration Authority

The internal HTTP entry is `POST /rpc/agent-acp/apply-execution-snapshot`.
It accepts JSON only and delegates to the same execution directory as local
access checks. The request body is bounded independently from ACP prompt size
(16 MiB by default, `ANTNEST_ACP_MAX_CONFIGURATION_BYTES`). Unsupported methods/content types, invalid JSON, oversized
bodies and invalid configurations must not reach live publication. Responses
distinguish validation (400), conflict (409), payload size (413), content type
(415) and temporary inability to apply (503). A missing production publisher is
unavailable, not an empty successful configuration.

The HTTP boundary carries the RPC method, applied organization/revision and
safe error identity. Neither request/response contents nor raw error messages
are captured for this secret-bearing operation, even when global RPC content
capture is enabled. Controller cannot infer overall Agent readiness from this
configuration acknowledgement alone.

Controller publishes one complete current execution configuration per
organization. ACP validates the whole configuration before replacing its local
view. Missing references, duplicate identities and unsupported authentication
fail the update rather than deleting part of the current configuration.
The retained `skill_instructions` field must be empty. ACP rejects a nonempty
publication and a persisted Run snapshot containing legacy Skill bodies before
accessing Runtime. The system prompt contains no bulk Skill body; each Run reads
Runtime Skill summaries and fetches a selected body through the existing Runtime
path when needed.

`execution_configurations` stores only the non-secret current configuration and
revision in ACP's database. Credentials remain inside volatile logical Provider
clients. A stored revision is not current-process readiness. Equal-revision
publication after restart restores credentials; older input cannot initialize
the service or reverse a newer revocation.

Publication failure after storage leaves the affected organization closed until
same/newer configuration completes publication. Connection routing is immutable;
authentication rotation changes its credential revision without binding it to
a Run. Disabling or removing a Provider immediately revokes its clients, aborting
current requests and rejecting later use of existing handles.

Every synchronization reads the stored current revision before CAS. Losing a
commit acknowledgement must not trap retries behind an older cached revision.
The in-memory directory contains only successfully published configurations;
stored state and volatile client material are separate facts. Revoked handles
remain unusable after re-enabling a Provider; re-enabling creates a fresh client.

## Local Identity And Session Configuration

Production composition uses the trusted organization/principal/Agent
tuple from Gateway. Connection establishment does not query Controller and does
not decide Agent availability. Resource methods authorize against the currently
applied organization snapshot; a disabled Agent can still expose authorized
history and Session configuration without granting execution.

Session organization ownership is immutable and survives removal of the Agent
projection. The model selector reads the same complete local directory used by
execution, not a paginated Controller catalog. Configuration writes share the
local publication boundary with access revocation, so an acknowledged revocation
cannot be followed by a late configuration commit based on old access.

Permission replies use this same short boundary when committing a decision or
remembered rule. The saved Run's access revision must still match the applied
grant. Waiting for a client reply is outside the boundary; cancellation cleanup
may close an obsolete request after revocation, but cannot save a remembered
allow/deny rule. A storage failure is not converted into an approval rejection.

Publication synchronously aborts revoked execution lifetimes, detaches their
permission connections and closes their output subscriptions before acknowledging
the new revision. It does not wait for a model, Runtime call or buffered output
delivery. The Agent slot remains occupied until execution actually finishes.
Closing new Run admission alone does not revoke existing access or cancel a Run.

If live publication fails after persistence, all local access consumers for the
affected organization are closed until a retry succeeds; other organizations are
unaffected. A retry never revives an aborted lifetime or detached connection.

The old opaque subject and per-connection access revision are removed rather than
supported as fallback authentication. Default approval remains overridable by
the owner; neither mode overrides nor model selection can change resource ownership.

## Execution Ownership

Prompt submission is one application operation: reserve the local Agent slot,
persist acceptance, and start the executor under that slot. Its result contains
the accepted Run and a completion promise. The ACP transport observes this
promise; it does not make a second call that starts execution. Delivery failure
cannot orphan accepted work, and reconnect cannot manufacture a new execution
slot for an old Run.

The slot is keyed by organization and Agent, not Session or connection. It spans
acceptance, execution, cancellation and terminal persistence. Cancelling while
acceptance is still committing aborts the same lifetime; if acceptance commits,
the executor receives the aborted signal and performs local terminal cleanup.
Cancellation acknowledgement does not release the slot before the delegate
actually finishes. Shutdown stops new submissions and waits for these owned
lifetimes. Process failure is still interruption, never automatic replay.

Agent-level lifecycle settlement uses this same slot, including acceptance that
has not yet returned. Its local `wait` operation does not cancel execution;
`cancel` aborts that lifetime but still waits for its actual completion. The
caller's deadline or disconnection can stop waiting, not release the slot or
declare the remote operation stopped. An already-expired request must not send
cancellation. Organization and Agent jointly identify the target.

This local result is only dispatch quiescence, not the public `settled` result.
`POST /rpc/agent-acp/settle-agent` delegates to the settlement application, which
validates the current closed configuration and operation before taking the slot,
waits outside the configuration boundary, and revalidates before responding.
It separately consults durable Runtime stopping evidence; a local completion
boolean cannot stand in for it. The route shares JSON request validation and
the configured body limit with configuration application. Unlike credential
publication, its validated non-secret request/result may use normal RPC capture.

The settlement contract uses the existing closed lifecycle operation and its
absolute deadline. A stale operation is a 409 conflict, including when it becomes
stale during the wait; it is never a successful acknowledgement of a newer
operation. Expiry/disconnection returns `not_settled` for a still-current operation
without freeing its active slot. Database failure returns unavailable, not idle.
Only after local quiescence does the application read stopping evidence under a
fresh closed-operation check. No Runtime revision in the closed configuration
means checking all of that Agent's historical calls, not assuming no calls exist.

New prompt admission checks the same durable protection before storing an input.
A changed endpoint or execution ID with the same Runtime revision cannot bypass
it. A new revision is the Controller's confirmed replacement boundary; the old
history remains immutable. Read-only Session access is unaffected.

Settlement inspects the published operation synchronously before cancellation
and after asynchronous work. It does not join the organization commit queue or
hold that queue while reading evidence. Unpublished candidates are never read.
Evidence reads are cancellable: timeout/disconnection closes their borrowed
database connection; cancellation during pool acquisition releases any late
connection without issuing SQL. Standard pool connection/query and PostgreSQL
statement timeouts bound database work independently. This cancellation helper
is for reads, not a claim that an interrupted write rolled back.
Service stop or worker ownership loss is a separate signal: it makes settlement
unavailable even if the Run subsequently finishes. It cannot become a success ACK.

The Runtime MCP adapter reports stopping evidence separately from effect state:

| Received result                                                                       | Foreground stopping evidence                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Builtin success or a recognized ordinary builtin error                                | Stopped/not dispatched according to that result's contract      |
| `write`/`edit` `outcome_unknown`                                                      | Stopped; retain unknown historical effects                      |
| `bash` `outcome_unknown`, `runtime_failed`, or `child_process_containment_unproven`   | Unproven, even if the effect projection says `none`             |
| Managed tool's normal terminal result, including ordinary tool failure                | Stopped for this invocation, not all server/background activity |
| Managed `outcome_unknown`, unproven containment, transport loss or malformed evidence | Unproven                                                        |

Classification uses tool identity and structured protocol fields, never message
text. A failed connection before `tools/call` is not dispatched. Connection
cleanup failure after a confirmed result does not reverse its stopping evidence.
Unknown result codes cannot prove a builtin stopped. No helper kills previous
background jobs or modifies Runtime's producer contract in this batch.

Stopping evidence is retained on the existing `tool_attempts` record as
`runtime_call_stopped`, initially false. Only the adapter's positive evidence
can set it true in the same transaction as the tool's terminal event. Failure
or interruption without that evidence preserves false. This is separate from
`tool_effect_state`; completing a Run does not clear it. The local protection
query scopes these facts by immutable Session organization/Agent and the Run's
Runtime revision, so a mere process restart or changed endpoint does not erase
them. No new event queue, cross-service table or Controller Run record is needed.

Output invalidation is a best-effort hint backed by persisted Session events.
Submission installs the hint callback before execution can begin; reconnect
reads the current durable output. An absent or failed transport consumer does
not govern execution lifetime. Protocol v1 waits for the completion result;
v2 acknowledges acceptance and subsequently streams the durable result.

The execution decorator records terminal class, executor state and Tool effect
provenance on the Run span. Removing Controller completion RPCs must not remove
that diagnostic information or move telemetry into the business loop.

Acceptance returns the Session's pre-submission output sequence. Prompt output
attaches from that cursor, not a newly queried latest cursor: execution can
already have emitted output before the transport subscribes. The transport
enables invalidation only after attaching its output observer; v2 schedules
that observer after its acceptance response. This is delivery ordering, not an
execution-start acknowledgement.

## Workspace Execution State

State subscriptions are invalidation hints followed by current reads, not an
event journal. Unsubscribing is idempotent and cannot remove a newer subscription.
A configuration-publication failure invalidates observers even if its cleanup
callback fails. A revoked stream attempts one sanitized final state and then
closes; delivery is best effort, never a prerequisite for revocation.

The HTTP transport bounds each blocked write and final response flush with
`ANTNEST_ACP_STATE_DELIVERY_TIMEOUT` (default `10s`). On expiry it closes the
connection and releases listeners. The deadline does not limit the lifetime of
an idle subscription and does not add polling or heartbeats. Reconnection reads
current state instead of assuming that the terminal frame was delivered.

`get-agent-execution-state` and `watch-agent-execution-state` are read-only
internal POST routes. They consume trusted caller headers and an empty JSON
body. The state derives from the live execution directory, local Agent slot and
durable old-Runtime protection, never Controller Run admissions or a new table.
Read failure is unavailable, not idle. Busy includes acceptance and terminal
cleanup. Only the active Session owner receives its ID; an authorized peer can
observe Agent occupancy without obtaining another user's Session.

Subscriptions register before reading, coalesce invalidations, and send current
snapshots rather than every intermediate transition. No polling is introduced.
Access revocation closes the old subscription and clears disclosed identifiers;
regrant requires a new subscription. A blocked database read is cancellable and
does not hold configuration publication. Delivery enqueues synchronously after
its final access check and respects transport backpressure and cancellation.
Only stream metadata, not contents, enters telemetry.

The configuration comparison token excludes occupancy, lifecycle status,
organization revision and credential rotation. It changes for relevant Agent,
Runtime or model-catalog settings. Existing workspace bootstrap and state
consumers require B3/B4U migration; service-local routes do not constitute
cross-service integration acceptance.

## Local Run Inputs

Run acceptance resolves the current organization configuration and the captured
Session overrides locally. The immutable execution snapshot identifies the
organization, logical Provider connection and model profile, and fixes model
parameters, authorization and Runtime binding. It contains no Controller
admission ID, credential reference or credential version.

The local execution deadline is fixed when accepting the input, using ACP's
execution timeout. It is independent of lifecycle settlement and is not extended
by configuration replay or reconnect. Credential lookup is absent from Run
acceptance and execution: the executor holds a logical client for actual work,
and that client injects current authentication into each outgoing model request.
Model loops and permission classification receive no secret field. Retirement
prevents new client acquisition but lets an existing holder finish and receive
authentication rotation. Missing clients fail before Runtime setup.

## Startup Interruption Cleanup

Startup is not Run resumption. Its recovery inputs are unfinished local Run
identities and state, not old request/configuration snapshots used to reconstruct
model calls or replay Controller admission.

1. Reject an unaccepted Run as interrupted before execution; preserve a durable
   cancellation request as cancellation.
2. Reconcile in-progress Tool attempts for an accepted Run using stored evidence.
3. Persist failure for known effects or unresolved for unknown effects. Keep
   partial output and completed Tool results.
4. Leave already-terminal Runs unchanged even if an obsolete Controller finish
   receipt was never recorded. No reverse completion notification is sent.

Startup failure or worker-owner loss stops further writes. Cleanup and current
configuration application are both required before new work; neither proves an
uncertain old Runtime command stopped. Prompt admission reads durable protection
before creating a new intent. Agent-level settlement reports whether the current
binding requires replacement, independently of startup cleanup.

## Remaining Integration

Test migration follows the new ownership boundary: model transport tests still
verify authentication on the outgoing request, while TurnRunner/context tests
must carry no credential. Snapshot fixtures keep model/Runtime/deadline facts
without Controller tickets or credential versions. Tests for retired Controller
RPC transport are replaced by inbound snapshot contract and local execution
tests, not kept alive through a fake compatibility client. Cancellation,
ownership loss, storage failures, protocol isolation and output replay remain
required behaviors even when their old fixtures are removed.

The retired Controller transport's pricing, optional native-input flags and
closed configuration validation now belong to `execution-contract.test.ts`
and `execution-configuration.test.ts`. Local rejection, acceptance commit
uncertainty and non-secret terminal storage belong to the coordinator/executor
tests. Outbound acquire/finish serialization, Controller status probing and
credential-version rejection are removed behavior, not compatibility promises.
No test-only Controller adapter or obsolete catalog decoder is retained.

PostgreSQL protocol fixtures now apply an actual execution directory backed by
the configuration repository, not an outbound Controller mock. Trusted identities
enter through the same transport headers. Configuration changes are published
before checking access, model selection, approval or output effects. Provider
authentication is supplied by real logical clients to the model transport.

The regression suite separates transport content capabilities from the selected
model's capabilities. Malformed attachments are rejected before intent storage;
a valid attachment unsupported by the selected model records a failed execution
without an outgoing Provider request. Access revision changes preserve a still-
authorized connection; actual revocation cancels execution and suppresses output.
Session organization ownership and the local `deadline_at` are explicit in SQL
fixtures, including lock-wait/expiry tests. Application recreation uses current
synthetic configuration to rehydrate volatile credentials, never a Run snapshot.

Subsequent B5 integration verified Controller-driven close, settlement and confirmed
replacement, Gateway state consumption, and Console execution-audit reads after
deletion/restart. Historical queries use immutable Session organization ownership,
not live execution grants. Normal execution is locally assembled without Controller
calls. The [final integration record](../../../docs/controller-acp-execution-boundary-plan.md#103-可执行的小步交付)
distinguishes the passed business/topology scope from strict clock-warning failures.
