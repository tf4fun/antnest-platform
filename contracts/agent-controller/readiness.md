# Agent Readiness Contract (#44, Pending)

This document defines the pending shared semantics for
[#44](https://github.com/tf4fun/antnest-platform/issues/44). Controller production,
ACP consumption, UI and Console consumption, and cross-service integration are
all pending. It does not change an active JSON contract, schema, contract
revision, route, or enforced caller. Formal schemas, shared fixtures, and the
consumer rollout must be frozen before an owning-service batch enables the new
behavior. The existing [Controller contract](control-api.md) and
[ACP execution API](../agent-acp/execution-api.md) remain the active interfaces.

## Binding and Applied Readiness

Two facts replace the current use of Runtime health as Agent readiness:

- `runtime_bound`: Controller has committed the current executable Runtime
  binding and the organization execution-configuration revision containing it.
- `agent_ready`: ACP has acknowledged applying a snapshot that covers that
  binding, and Controller has checked that the same binding is still eligible.

The binding transaction must persist `runtime_bound` and
`ready_after_revision` together with the binding and organization revision
advance. `ready_after_revision` is the resulting organization's
`execution_configuration_sync.revision`: a positive JavaScript-safe integer, at
most `9007199254740991`. It is not the Agent's lifecycle execution revision,
`NextExecutionRevision`, execution-revision ID, Runtime generation, aggregate
sequence, or opaque ACP `configuration_revision` digest. Revision comparisons
always use the same organization. An unbound Agent has no completed binding
threshold; absence or zero cannot prove readiness.

Recording an ACP acknowledgement must update the persisted applied watermark
and evaluate eligible readiness transitions in the same database transaction.
An acknowledgement must belong to the organization and cannot exceed its
committed execution-configuration revision. The transaction must recheck the
current binding identity, access and owner authorization, desired and confirmed
lifecycle state, active lifecycle operation, and current Runtime condition.
Only a still-eligible current binding with
`ready_after_revision <= applied_revision` may produce `agent_ready`.

An old acknowledgement cannot restore a replaced binding, revoked access, or
execution closed by Disable, Delete, Rebuild, or Runtime failure. Repeated or
concurrent acknowledgements must not duplicate `agent_ready` for the same
binding. The readiness fact and event must commit atomically. A later binding
has its own threshold and readiness decision; an Agent's historical ready event
is not authority for that later binding.

## Current Agent Readiness

The pending Controller Agent projection uses
`readiness: preparing | ready | unavailable` independently from lifecycle
operation completion and Runtime health:

- `preparing`: an otherwise eligible Agent is awaiting its binding or an ACP
  acknowledgement covering the current binding.
- `ready`: the current eligible binding has an applied acknowledgement covering
  its threshold.
- `unavailable`: current access, desired or confirmed lifecycle state, active
  lifecycle work, or Runtime condition prevents execution. Such a blocker takes
  precedence over a historical ready fact or an outstanding acknowledgement.

Successful Create, Enable, or Rebuild provisioning does not itself mean ready.
Runtime health alone does not mean ready either. This projection is not ACP Run
occupancy: an active Run can make ACP busy without invalidating its binding.
Storage or state-read failures remain errors and cannot fabricate a ready
projection. Exact field placement and schema requirements remain pending formal
schema freeze.

## Publication Must Not Wait for Its Own Acknowledgement

`accepting_runs` remains a projection of current access, lifecycle eligibility,
Runtime condition, and a complete executable binding with the required private
authority. It must not require Controller `readiness == ready` or an already
recorded ACP acknowledgement.

Before the binding exists, a known, authorized, preparing Agent can be listed in
an organization snapshot with `accepting_runs: false` and
`unavailable_reason: "agent_preparing"`. Once the binding is complete and the
existing execution prerequisites hold, the snapshot containing that binding
must be publishable with `accepting_runs: true`, even while Controller remains
`preparing` waiting for the response. ACP applies that executable snapshot and
returns its acknowledgement; Controller can then record `agent_ready`.

Publishing a closed snapshot, waiting for its acknowledgement to mark ready,
and only then making it executable would create a readiness/publication cycle.
It is forbidden. A readiness acknowledgement alone must not rewrite a snapshot
under the same revision or require another configuration revision solely to
open execution. Equal-revision configuration and private-authority immutability
continue to apply. Closed bindings retain the existing fence-only rule and do
not transfer executable Runtime credentials.

## Preparing Admission and Privacy

Known preparing Agents remain listed for their currently authorized principals,
so ACP can distinguish pending execution from denied access. This does not
substitute a pending rebuild target for an old committed configuration, restore
revoked principals, or preserve deleted Agents as executable entries.

After ordinary authorization succeeds, a listed Agent carrying
`agent_preparing` uses the existing
[ACP error catalog](../agent-acp/errors.json) entry:

| Field                         | Existing catalog value         |
| ----------------------------- | ------------------------------ |
| `data.code`                   | `agent_preparing`              |
| JSON-RPC code                 | `-32033`                       |
| HTTP status, where applicable | `503`                          |
| `data.retryable`              | `true`                         |
| `data.retry_after_ms`         | `1000`                         |
| Catalog recovery              | `backoff`                      |
| Safe message                  | `Agent execution is preparing` |

No new numeric error code is needed. Clients use the negotiated catalog rules
and actual receipt; they must not infer retry from message text. Retry guidance
does not authorize replay of an accepted Prompt or a request with an unknown
acceptance outcome.

An unlisted Agent or a principal without access still receives `access_denied`,
without revealing whether Controller knows the Agent. A completely unavailable
organization configuration remains `configuration_not_ready`; ACP must not
invent a listed preparing Agent from an unavailable source. No per-Run Controller
lookup or removed Controller admission route is introduced.

The pending ACP get/watch execution-state contract can represent an authorized
preparing Agent using the existing `availability: "offline"` with
`unavailable_reason: "agent_preparing"`. It does not add a new availability enum.
Existing busy/active-Session visibility, revocation sanitization, storage failure,
and Runtime barrier rules remain intact. Formal schema and UI consumption of
this reason must precede emission; this document does not implement them.

## Compatibility and Delivery

Historical events are immutable. Existing `agent_ready` rows were produced under
the earlier health-based semantics and must not be rewritten or treated as proof
of an ACP acknowledgement for the current binding. A migration must establish
current readiness from a matching applied-configuration fact; healthy Runtime
state or a legacy event alone is insufficient.

The active event contract continues to accept historical `schema_version: 1`
events without new required fields. The formal contract design must distinguish
new ACP-acknowledged readiness proofs through a version or payload shape; this
document does not choose that representation. It must not add required fields to
historical `agent_ready` events. Compatibility changes for current strict
readers and the active manifest and schemas must be completed before producers
emit the new facts. This pending document leaves active control revision 40 and
the existing schemas unchanged.

During rollout, a legacy response without the new readiness field is unknown,
not ready. Consumers must not infer readiness from lifecycle completion,
`runtime_state: "available"`, an old event, or a missing field. Strict readers
must accept the new event type and projection before producers enable them.
Schema compatibility for historical events must remain explicit rather than
requiring new fields on immutable old records. This document does not increment
the active control revision; the formal contract batch must synchronize that
revision and schemas before enabling the service behavior.

Delivery remains split into owning-service batches:

1. Freeze the formal shared schemas, fixtures, compatibility and consumer rollout.
2. Implement Controller binding facts, organization revision thresholds,
   transactional ACK gating, idempotent ready events and management projection.
3. Implement ACP preparing admission and get/watch state consumption, preserving
   unknown-Agent privacy and existing authorization and execution barriers.
4. Implement UI preparing presentation and state observation, and Console use of
   the new meaningful ready fact. Accepted or uncertain Prompts are not replayed.
5. Run explicit cross-service integration after the owning-service gates pass.

None of these implementation or integration stages is completed by this
document. Controller component evidence must cover interleavings of binding,
publication and acknowledgement, including stale, duplicate and cross-organization
acknowledgements and concurrent revocation or lifecycle closure. ACP evidence
must distinguish listed preparing Agents from denied or unlisted Agents.

The required real Docker E2E remains pending: artificially delay publication by
two seconds, create an Agent, wait for the new `agent_ready`, then immediately
Prompt successfully in each of 100 iterations. It must independently verify Run
persistence, Runtime behavior, authorization, no replay, and actual resource
cleanup. Span and Trace collection are auxiliary diagnostics and cannot replace
or block those business checks. Complete merge gates run in remote CI; this
pending contract is not evidence that #44 is complete.
