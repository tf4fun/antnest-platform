# ACP workspace Bridge extension

Status: **B0 contract, ACP producer and Node consumer implemented**. Targeted `session/cancel`
metadata checks the durable Run ID and in-memory execution slot. Durable intent
records, principal-scoped observation RPC, negotiated delivery marks and
capability advertisement are implemented. ACP unit, integration,
PostgreSQL/E2E, production-image and container smoke gates passed. Node and
Gateway local gates and the six-service browser regression passed. Two independent
ACP connections racing on one configuration revision have exactly one winner in
the production-image regression. The real-stack two-Node-owner race also passes:
one write succeeds, the other returns 409, and both views converge on the
winner. Schemas for platform-owned values are
[`workspace-bridge.schema.json`](workspace-bridge.schema.json). The public ACP
v1 message shapes remain those of installed SDK 1.5.0; clients that do not
negotiate the extension retain existing behavior.

The installed SDK also includes experimental `notice` updates. The current
Bridge does not advertise `clientCapabilities.session.notices` or project them.
The separate [Skill learning notification proposal](../../docs/skill-learning-notifications-design.md)
selects SDK `notice` for live delivery, with a planned `learningNotices` Bridge
capability and namespaced change metadata. SDK HTTP routes notices through an
associated delivery Session; learning-source IDs are separate metadata. Durable
learning-result reads restore Node/FE projections after gaps; they do not reuse this contract's ACP transcript
watermarks or add notices to `session/load` replay. This capability, recovery
routes and workspace fields are reserved by the
[L0 contract](../skill-learning/learning-api.md) and not yet implemented here.

## Capability and wire shape

The Bridge requests the namespaced capability `antnest.dev/bridge` during
`initialize`. ACP advertises `bridgeCapabilities` in the response `_meta`
only when all three version-1 parts are ready: durable intent receipts, target
Run cancellation and delivery marks. If any is absent, Node must not expose
reliable prompt admission for that connection. The official SDK's `PromptRequest`,
`CancelNotification`, `LoadSessionResponse`, `InitializeResponse` and Session
notifications permit `_meta`; the names below are Antnest extensions, not
official ACP fields:

`bridgeCapabilities.configurationCas: 1` is an additional, independently
advertised capability. The Bridge must require it for conditional Session
configuration writes; its absence does not change prompt admission. The ACP
producer batch will advertise it only after the durable comparison and
transport metadata are implemented.

- `session/prompt.params._meta["antnest.dev/intent"]` has `intentId` and
  `expectedAppendVersion`.
- `session/cancel.params._meta["antnest.dev/target-cancel"]` has `expectedRunId`.
- `session/set_config_option.params._meta["antnest.dev/configuration"]` has
  `expectedRevision` when the Bridge issues a conditional configuration write.
- `session/load.result._meta["antnest.dev/delivery"]` has a sealed replay
  watermark and the current append version.
- Each relevant `session/update.params._meta["antnest.dev/delivery"]` contains
  a `part` or `checkpoint` mark. A part names its persisted event sequence,
  part index/count and stable run/message identity. A checkpoint advances over
  a persistently sequenced event with no public ACP update.

Events without a Run (for example Session configuration) use `runId: null` in
a part; `messageId` still names the durable Session event. Checkpoints ride a
standard `available_commands_update` notification, so no private ACP method is
required. They can also seal gaps caused by filtered or non-visible events.

The negotiated transport remains official ACP v1 Streamable HTTP
(`POST` messages, `GET` SSE). These fields do not add a new method or change a
standard response body. B1 tests cover actual SDK encoder, HTTP/SSE transport
and parser preservation in addition to schema acceptance of `_meta`.

## Conditional Session configuration

The execution observation's `configurationRevision` is the lowercase SHA-256
hex digest of UTF-8 `JSON.stringify([sessionId, decimalConfigurationRevision])`.
`decimalConfigurationRevision` is the current durable
`acp_sessions.configuration_revision` integer written by the Session
configuration repository. A successful Session configuration change advances
that integer exactly once. The observation must return a non-null revision
for an authorized, existing Session and read it in the same consistent
snapshot as its other execution fields. The digest is an opaque equality
condition, not a browser authorization token.

The Bridge includes that observed revision in the standard SDK
`session/set_config_option` request's namespaced `_meta` as specified above.
ACP validates the metadata, rechecks Session access, compares the condition
with the current durable revision, then writes with the repository's existing
numeric compare-and-swap. A stale condition or a concurrent winner returns
`configuration_conflict` without changing configuration. A malformed condition
is invalid parameters. A missing condition from an ordinary ACP client retains
the standard method behavior; the Bridge must not omit it. The Bridge's
separate signed browser configuration token remains scoped to principal,
Agent, Session and Bridge epoch and is checked before forwarding the producer
condition. This contract does not make local View equality a substitute for
the producer's atomic check.

## Admission and recovery

The durable key is `(organization, principal, agent, session, intentId)`.
ACP validates access first, then looks up that key. It compares a
server-computed canonical digest of ordered normalized content blocks and
semantic admission parameters, including the original expected append version.
A same-key/same-digest duplicate resolves to the original receipt through the
scoped query; a different digest is `idempotency_conflict`. The digest and receipt are not
accepted from the caller. A revoked caller cannot read a previous receipt.

The receipt, Input/Run intent and Session append position must commit in one
database transaction with a uniqueness constraint and compare-and-swap on the
append version. Every successful prompt admission, including an ordinary ACP
client without metadata, advances that version. The existing transition from
persisted intent to accepted/rejected execution remains recoverable if a
process stops between transactions. In-progress intent lookup reports its
truthful state; it cannot create a second Run to repair a missing response.
Duplicate lookup precedes busy checks. Different keys racing for the same
append position cannot both commit. ACP remains Agent-level admission
authority even when multiple principals or non-Bridge clients are connected.

The append version counts a **durably reserved Input/Run intent**, including
one subsequently rejected before execution; it does not count token updates
or only completed user messages. Existing Sessions start at version zero when
the additive migration is applied, so the number is not a historical message
count. A duplicate standard ACP prompt request may receive
`intent_already_recorded` (or `agent_busy` during a reservation race); the
Bridge reads the original receipt by intent ID. Neither response authorizes
a new ID or automatic resubmission.

The principal-scoped internal `GET` observation routes are proposed as
`/rpc/agent-acp/workspace/sessions/{sessionId}/execution` and
`/rpc/agent-acp/workspace/sessions/{sessionId}/intents/{intentId}`. They receive
trusted organization/principal/Agent headers from the Node caller, no identity
body fields, and recheck current access before reading. The first returns
`executionObservation`, the second `intentReceipt`; the latter may return
unknown/expired rather than asserting that an absent record proves no
execution. They are not exposed by Gateway and do not use administrative
audit APIs. Receipt retention follows Session retention; an expired receipt
must have a distinct `intent_receipt_expired` outcome. A lookup across a
Bridge restart needs no old Bridge epoch or old history token.

`session/prompt` still gives the official `PromptResponse` to the original
request. A duplicate SDK prompt may wait for that same Run or return its
recorded standard result; B1 freezes which behavior the transport supports.
It may never start another Run. Receipt queries supply the richer durable
state. Bridge `202` is not evidence of ACP acceptance.

`session/cancel` remains a notification. With the negotiated target metadata,
ACP checks that `expectedRunId` is the current Run at its durable cancellation
decision, then passes that exact identity into the in-memory RunSupervisor.
After each await, the supervisor rechecks that it is aborting the same slot.
An old notification cannot cancel a replacement Run. Without the extension,
ACP preserves its existing ordinary session cancel semantics for other clients.

## Output completeness

`outputWatermark` is the highest durable Session event known to ACP. It is not
the number of ACP updates. A persisted event can emit several updates; a
complete `partCount` batch is required before Node advances that sequence.
Text content blocks larger than 64 Ki UTF-16 code units are emitted as
consecutive standard ACP message chunks, each at most 64 Ki code units and
never split between a surrogate pair. All chunks keep the original message
identity and the same durable event sequence; their `partIndex` and
`partCount` cover the expanded batch. Concatenating their text in order must
recover the original block exactly. This bounds the `text` field of each
notification without changing the watermark or treating a partial batch as
complete. Other fields in the block, `tool_call` fields and non-text content
remain unbounded; those require a separate producer/consumer contract before
claiming a general frame limit. The Node consumer also limits one event to
4096 parts, which must be considered for exceptionally large durable events.
The ACP model adapter bounds a non-streaming completion response body to
4 MiB before JSON parsing, matching the existing 4 Mi-character aggregate
ceiling on streaming completion data. Oversized model output fails the Run
with `model_invalid_response` before publication; it must not become a giant
single durable Session event. This does not replace the separate ACP prompt
POST admission bound or bound other non-text sources.
Filtered state/configuration events use an explicit checkpoint so there is no
silent gap. `session/load` returns a sealed cut after replay has emitted all
updates through that watermarked point. Later live updates have larger
sequences or are deduplicated against the cut. Node only replaces a replay
candidate or clears a completed overlay when its observed delivery marks
prove it has all required output through the receipt's terminal watermark.
Replay/live boundaries and split update ordering have transport and database
tests in B1; the Node consumer additionally checks complete batches and keeps
the prior view when a replay fails.

The metadata gives stable Run/message identifiers for historical turn
anchors. It must not fabricate missing original timestamps. ACP retains
complete content as authority; compact views and pages are Node projections.

## Rollout

B1 ACP producer and the Node Bridge consumer have passed their separate local
unit, contract, transaction, transport and service-container gates. Ordinary
ACP clients retain the standard method behavior. The six-service regression
passes with the current producer and consumer, including a browser Mode change;
the producer's isolated PostgreSQL and production-image tests reject a stale
conditional change. The production-image test also races two independent ACP
connections and checks that the persisted revision advances once. The real-stack
Docker/Chromium test races two separate Node Bridge containers on an isolated
Session and checks one 200, one `configuration_conflict` 409, and two converged
views. Deploy the ACP extension first; the Node Bridge fails closed
for reliable submission when the negotiated capability is missing, and rejects
conditional configuration without `configurationCas: 1`. Rolling back ACP
while Node uses receipts is unsafe;
first drain/switch Node scopes, then roll back the producer without deleting
stored intent records.
