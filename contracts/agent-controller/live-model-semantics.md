# Live model semantics (#46)

The [proposal](live-model-semantics-proposal.json) defines how Agents follow
live Model Profiles and Provider connections while Template prompt, runtime,
MCP and Skill inputs stay immutable. Controller control revision 48 activates
the proposal: the usage and event routes, the `effective_models` reader
projection, the model-scoped revision journal and the optional
`model_profile_revision` on published models. ACP and Console consumer batches
are delivered consumers-first: the ACP reader, admission freeze and
audit projection are implemented; the Console usage/confirmation surface is
pending, and the Controller's new producer fields must deploy only after ACP.

The model journal does not extend the Agent `event_type` enum, and the
proposal introduces no optional model revision pinning. Issue #72 catalog and
default ownership stays out of scope.

## Live versus immutable inputs

A Model Profile and its Provider connection are live: Agents always execute
against the current profile head, so revising a model changes what new work
sees without an Agent rebuild. Template prompt, runtime, MCP and Skill inputs
are immutable: an Agent keeps the Template revision it was built from until an
explicit rebuild. `revision` is the profile's update counter and
`revision_id` its opaque configuration stamp; neither is a pin that an Agent or
Template can select. There is no model-history resource and no way to execute
against an old revision.

## Reading effective models

Agent detail gains `effective_models`: an array of
`{model_profile_id, revision}` entries giving the current revision of the
primary and each ordered fallback profile ID from the executable or retained
spec, deduplicated by profile. It is a reader projection of live state, not a
rewrite of frozen configuration or model lineage. When the Agent has no
executable spec the field is omitted rather than emitted empty.

## Usage counts

`GET /internal/model-profiles/{model_profile_id}/usage` requires the verified
`organization_id` and returns `{templates, agents}` as nonnegative integers.
`templates` counts unique current Template heads — including disabled heads —
that reference the profile as primary or ordered fallback. `agents` counts
unique non-deleted Agents that reference the profile in the effective spec or
in an active lifecycle target spec, deduplicating primary and fallback
references. Counts are a complete informational snapshot: they are never
truncated, never aggregated across organizations, and an unknown or
cross-organization profile fails closed with 404. They are not a transaction
fence and do not block revision.

Both routes accept only the admin-console workload caller with required caller
context, matching the existing Model Profile read policy.

## Model profile revision events

Every committed profile revision writes one `model_profile_revised` event to a
durable model-scoped journal, in the same transaction as the revision row and
the request receipt: no event on profile create, none on a rejected CAS, and no
duplicate on receipt replay. The event records `request_id`,
`organization_id`, `model_profile_id`, the new `revision_id`,
`previous_revision`, `revision` (exactly `previous_revision` plus one) and
`occurred_at`. It never carries credentials or model settings. The journal is
independent of Agents: revisions of unused profiles still emit events, and the
Agent `event_type` enum and event journal are unchanged.

`GET /internal/model-profiles/{model_profile_id}/events` requires the verified
`organization_id` and pages the journal in ascending profile revision order.
`after_revision` returns entries with a strictly larger revision; `limit`
defaults to 50 and is capped at 100. The response is
`{items, next_after_revision}`, where `next_after_revision` is the cursor for
the next page or null at the end.

## Publication and Run snapshots

Each model entry in the execution snapshot and in publication v2 gains an
optional `model_profile_revision` positive safe integer. The new Controller
writer always sets the actual current profile revision — including
pricing-only and name-only revisions — and advances the publication revision
whenever published metadata changes. Snapshots written before the writer lands
remain valid because the field is optional, but strict readers reject unknown
fields: every consumer deploys before the producer starts emission, and no old
consumer is claimed to accept the property.

ACP freezes `modelProfileRevision` into the persisted Run snapshot and into
each `ModelCandidate` — primary, ordered fallbacks and the compactor — at Run
admission. An already active Run keeps its frozen snapshot; the next accepted
Run uses the newly published revision. The audit detail gains an optional
nullable `model_profile_revision` for the primary admitted profile: `null`
marks unknown historical snapshots and is never fabricated from the current
Controller row or `configurationRevision`. Fallback and compactor revisions
stay inside the immutable candidate snapshot.

## Console editing flow

Admin Console adds `GET /api/admin/model-profiles/{id}/usage` as a BFF route
with the verified admin scope. The model edit flow loads the usage counts
first and requires an explicit operator confirmation — including when both
counts are zero — before it POSTs a revision. A cancelled or failed count load
never saves. The counts inform the operator; they are not a precondition the
Controller enforces.
