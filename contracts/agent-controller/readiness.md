# Agent Readiness Contract (#44)

Control contract revision 41 defines the shared wire representation for
[#44](https://github.com/tf4fun/antnest-platform/issues/44) in the
[Controller schema](control-api.schema.json) and
[shared fixtures](readiness-fixtures.json). The formal Controller wire contract
and strict readers are delivered. Controller production, ACP preparing admission,
UI and Console consumption, and cross-service integration remain pending.
The ACP and Workspace state schemas now admit an authorized offline preparing
reason; Console contract 57 defines its optional current readiness projection.
These shared definitions do not enable new producer
behavior, routes, or caller permissions. Consumers must accept the new wire
representation before a later owning-service batch emits it. The
[ACP execution API](../agent-acp/execution-api.md) retains its existing envelope.

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
projection. The Controller `agent` schema places `readiness` at the top level
as an optional field, with no default. Legacy Agents without the field remain
valid and have unknown readiness. The field is not inferred from other state.

## Versioned Readiness Proofs

The event envelope retains its existing `agent_id`. A new `runtime_bound` event
uses `schema_version: 2`; an ACP-acknowledged `agent_ready` also uses version 2.
Version 2 permits only these two event types. Other existing event types continue
to use version 1. Both version-2 payloads require:

| Data field               | Wire constraint                         |
| ------------------------ | --------------------------------------- |
| `organization_id`        | Existing Controller ID schema           |
| `agent_spec_revision_id` | Existing Controller ID schema           |
| `execution_revision_id`  | Existing Controller ID schema           |
| `runtime_revision`       | Existing Controller ID schema           |
| `ready_after_revision`   | Integer from 1 through 9007199254740991 |

Version-2 `agent_ready` additionally requires `applied_revision`, with the same
positive safe-integer bounds. Its payload has exactly these six fields;
`runtime_bound` has exactly the first five. Unknown fields, private Runtime
execution IDs, endpoints, and credentials are not admitted in either payload.
The existing ID schema restricts values to 1–200 ASCII ID characters, beginning
with an alphanumeric character. Unknown schema versions and event types remain
invalid.

Schema validation proves shape and bounds only. The owning Controller transaction
must prove `ready_after_revision <= applied_revision <= committed revision`,
organization identity, current binding identity, and continuing eligibility.
The ACK request remains `{organization_id, applied_revision}` and the
execution-synchronization envelope does not change in this batch.

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

The ACP get/watch execution-state contract represents an authorized
preparing Agent using the existing `availability: "offline"` with
`unavailable_reason: "agent_preparing"`. It does not add a new availability enum.
Existing busy/active-Session visibility, revocation sanitization, storage failure,
and Runtime barrier rules remain intact. Formal schemas are defined; service and
UI consumption of this reason must precede emission. This document does not
implement those consumers.

## Compatibility and Delivery

Historical events are immutable. Existing `agent_ready` rows were produced under
the earlier health-based semantics and must not be rewritten or treated as proof
of an ACP acknowledgement for the current binding. A migration must establish
current readiness from a matching applied-configuration fact; healthy Runtime
state or a legacy event alone is insufficient.

The event contract continues to accept all 20 historical `schema_version: 1`
event types and their existing object payloads without new required fields.
In particular, historical `agent_ready` does not acquire ACK proof fields.
Version 1 cannot claim the new `runtime_bound` event. The readiness manifest and schemas were introduced together in control contract
revision 41 and remain unchanged in revision 42. Strict readers must be updated
before producers emit the new facts.

During rollout, a legacy response without the new readiness field is unknown,
not ready. Consumers must not infer readiness from lifecycle completion,
`runtime_state: "available"`, an old event, or a missing field. Strict readers
must accept the new event type and projection before producers enable them.
Schema compatibility for historical events remains explicit, without requiring
new fields on immutable old records. The shared fixtures cover legacy Agent
responses, historical events, complete version-2 proofs and invalid wire values.

Delivery remains split into owning-service batches:

1. Deliver the formal shared schemas, fixtures and historical compatibility.
2. Update strict Controller event and Agent readers in their owning services.
   Missing readiness remains unknown; accepting a new field or event does not
   enable preparing admission or certify readiness.
3. Implement Controller binding facts, organization revision thresholds,
   transactional ACK gating, idempotent ready events and management projection.
4. Implement ACP preparing admission and get/watch state consumption, preserving
   unknown-Agent privacy and existing authorization and execution barriers.
5. Implement UI preparing presentation and state observation, and Console use of
   the new meaningful ready fact. Accepted or uncertain Prompts are not replayed.
6. Run explicit cross-service integration after the owning-service gates pass.

The formal wire contract does not complete the pending implementation or
integration stages. Controller component evidence must cover interleavings of binding,
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
