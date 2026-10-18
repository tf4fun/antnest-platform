# Workspace protocol contract

`make e2e-workspace` must preserve the complete protocol scenario while moving
the retired public execution-state and direct ACP entrances to authenticated
private ACP. Browser, upload and layout coverage belongs to the separate C4
browser batch. This contract defines the migration acceptance; it does not claim
that the current protocol entry has already been migrated.

## Deployment, identity and state

Bootstrap Provider, Model and the returned immutable Template revision through
current public APIs. Build fresh candidates and verify sixteen raw services,
the fifteen-service Foundation projection, nine application image IDs and the
immutable Runtime image. Preserve the disposable project and its exact cleanup
boundary.

Use the original member login Session and Principal, bound to the Agent's
creation organization and owner. Delegate that Session through Identity's
workspace Resolve with the existing workload grants. The browser Cookie is not
sent to ACP. Do not add a replacement login, a test token issuer, a retired
Gateway route or an invented parent Span.

ACP owns the complete six-field execution state, including nullable opaque
`configuration_revision`, `unavailable_reason` and `active_session_id`.
Read it through the private state RPC and observe its private POST watch.
Preserve the original response status, schema-valid events, raw body, actual
exported HTTP CLIENT and ACP SERVER, their real parent edge and full closure
receipt. Identity validates access; a Controller admission-table oracle cannot
replace execution state. Retired public paths remain 404.

## Original connection and business inventory

Keep exactly five successful ACP v1 connections and five actual initialize
requests. The private opener already initializes; the consumer must not initialize
again. Preserve two Sessions and eleven business RPCs, in connection order:

1. Two `session/new` requests and the first held cancel-phase Prompt.
2. Load the other Session, reject its competing Prompt as `agent_busy`, send
   the cross-connection cancel notification for the first Session, and reject
   another Prompt as `runtime_barrier_required`.
3. Load the second Session after explicit Rebuild, then start its offline Prompt.
4. Load that Session to replay the single completed offline answer.
5. Load it after the second Rebuild, then complete the rebuilt Prompt.

The cancel is one actual `session/cancel` notification, without a request ID or
invented reply. Preserve its original notification receipt and complete server
transaction evidence. It is separate from the eleven business requests. The
post-revocation private Prompt probe and denied new connection are separate.
The probe is one additional actual RPC with an `access_denied` response and
zero execution effects; a denied Resolve must not count as a successful
connection or initialize. Archive all twelve business wire requests, retaining
the original eleven scenario requests as their own inventory.

Every initialized connection preserves actual wire request IDs, raw responses
and notifications, original request inputs/results and the complete cleanup
receipt. Shared Foundation/Restart connection gates retain their existing
prohibition on deliberate-close metadata. Workspace owns its exact two
deliberate-close expectations, bound to the original connection and request.

## Execution and recovery

Disconnect the first live bash Run, prove it remains active, reject a competing
Session without extra execution, then cancel it from the new connection.
Observe the original process group exiting and exactly the initial workspace
effect. Transport cancellation retains the same unresolved, quiescent,
unknown-effect public Run; process exit alone does not rewrite ACP's durable
knowledge.

The protected Runtime rejects the next Prompt with `runtime_barrier_required`
(`-32020`, nonretryable). Public Rebuild replaces that Runtime and clears its
protection while preserving the workspace and all unknown Run/audit facts.
Busy and barrier refusals must retain their original JSON-RPC errors and show
zero new Run, Provider or Tool execution.

Disconnect the second Run and let it complete once. A fresh load replays exactly
one answer with no new Run, model or Tool activity. The next explicit Rebuild is
visible to an already-open state observer, changes the configuration hash and
Runtime identity, retains workspace bytes, and lets the final Prompt use the new
execution binding. Retain three Runs (one unresolved and two completed), five
Provider requests, two bash calls and one read call.

Keep four explicitly admitted lifecycle operations: Create, two Rebuilds and
Delete. Each retains its exact replay, Temporal/SQL/publication evidence and
original settlement checks. The source-linked automatic Disable after owner
revocation is additional; it cannot substitute for an explicit lifecycle record.

## Revocation and trace ownership

Map the old Gateway-owned WebSocket policy closure onto the retained browser
Bridge in the separate C4 batch, as required by the
[retirement contract](../../../contracts/edge-gateway/workspace-entry-retirement.md#retained-behavior-and-evidence).
C4 must observe the actual remote browser event-stream closure before local
cleanup, blocked subsequent access and removed private UI content. A disabled
composer alone does not prove remote closure. This remains pending until that
browser batch passes its own Docker admission.

The private protocol batch preserves its owning service's revocation semantics.
The live state watch must emit the complete sanitized terminal view:
`access_allowed: false`, `availability: offline`, `active_session_id: null`,
`configuration_revision: null` and `unavailable_reason: access_denied`, with
the original `agent_id`, then reach remote EOF within the observed revocation
window. It is neither `workspace_error` nor a local cleanup cancellation.
Using the existing connection and its original CCT, send one actual Prompt and
require its wire `access_denied` JSON-RPC response. Preserve that response and
prove no new Run, Provider or Tool activity. Only after these observations may
the consumer close and join the idle private WebSocket.

A new connection attempt must preserve Identity's actual workspace Resolve
denial, including status, original body and actual exported Identity HTTP
CLIENT Trace/span IDs, using the original login token. Pass that CLIENT's
`traceparent` on the real Resolve request. Identity does not supply a Trace
response header; preserve its observed absence, and require a matching Trace
if a header is present. A generic thrown Error, dependency 503, network failure,
caller abort or expired CCT cannot substitute for the original revocation
evidence. ACP's existing `1008 caller_context_expired` policy is unchanged;
this migration adds no new idle-WebSocket revocation behavior.

Automatic offboarding disables the Runtime while retaining the workspace and
current Skill set. Validate its source-linked Temporal Disable trace. Delete
then removes all owned assets. A retained unknown call can still require a
Runtime barrier without a published Runtime revision; Disable/Rebuild/Delete
accept only the explicitly expected barrier receipt, never `not_settled`.

Collect all five initialize, eleven original business and one revocation-probe
request traces, the actual cancel notification, both state watches, offboarding
and all four explicit lifecycle operations. Include the real connection Links
and original Identity
sources. Private ACP ancestry starts at its exported CLIENT and actual ACP
receiver; no retired Gateway forwarding or public watch Resolve chain is
invented. Preserve complete persistence and execution bindings, including
cancellation. Read the Runtime's actual ready status (`agent_id`, `generation`
and `execution_id`) and bind its Agent and generation to the observed container's
`io.antnest.agent-id` and `io.antnest.runtime-generation` labels. Take
`runtime_revision` from that same Agent's Runtime projection, then bind the
execution ID and revision to model spans. The Runtime status does not contain
`runtime_revision`; public Agent summaries redact the execution ID. These are
distinct from the Tool's operating-system PID/PGID exit evidence.

The two deliberately disconnected Prompts require their original local-close
Error identity, missing wire response and matching connection-close receipt.
A same-shaped error, parent cancellation, response already received or unrelated
request cannot borrow this classification. Cancellation's unknown-effect Run,
Tool and Runtime diagnostics, and offline completion's response-dispatch
failure, require separate exact Workspace ownership. Busy/barrier errors and
the cancel transaction retain their owning service checks. Do not borrow Loss
unavailability or Shutdown process-shutdown exceptions.

Every raw error must have its exact owning Span and reason; unrelated errors,
missing parents, wrong Run/Runtime, capture defects and privacy leaks fail.
Keep original errors, warnings and timestamps unchanged. Collect three identical
complete current/connection/source snapshots, including late diagnostics.
Confirmed external SDK issues remain non-blocking under repository policy,
without new SDK investigations or workarounds. Do not tune clocks/export
intervals or use SIGKILL to obtain a pass.

## Failure preservation and verification

Business failure or one failed collector must not prevent independent request,
watch, notification, offboarding or lifecycle evidence from being collected,
unless the original parent aborts. Archive partial evidence and retain original
business, cancellation, collection, archive and cleanup errors together.
A passing summary cannot replace any original failure.

Join pending requests, all connections, response readers, watches and the host
exporter before removing its receiver. Preserve late parent cancellation,
including cancellation during the final exporter join. Cleanup must not relabel
the first remote close or a test-owned close.

Start with failing unit/contract cases and real HTTP/WS component coverage.
Run the complete Workspace and shared Foundation/Lifecycle regression, storage
policy and the isolated Docker protocol E2E serially, on unchanged source.
C4 browser acceptance follows as its own batch. Preserve durable private
evidence under `artifacts/verification/`; nothing lasting belongs in `.cache/`.
