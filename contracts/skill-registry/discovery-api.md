# Skill discovery and promotion v1

This document defines the Registry/source boundary and model tool inputs for
Skill propagation between Agents. The workflow has four steps: an Agent learns
a personal Skill; Registry projects it as a dynamic source mapping; another
Agent of the same owner finds and temporarily uses it; an administrator
promotes it to an immutable formal version that Templates can reference.
The [JSON schema](discovery-api.schema.json) supplements the
[fixed-version API](registry-api.md). Skill Registry implements the projection,
search, load and promotion routes; Agent ACP Service implements the source
routes and the model `find_skill`/`load_skill` tools; Antnest Runtime
implements temporary file delivery; Admin Console implements source preview
and promotion.

## Ownership, identities and scope

Projection is a **dynamic mapping**. Registry stores only organization, source
Agent, owner, canonical Skill name, description, source sequence, current
content digest and active/removed state. It stores no projected ZIP, Skill body
or complete file copy. Source content and lifecycle remain Agent-owned.

Agent sources are confirmed applied, ACP-managed personal learning packages. Owner-only access matches the existing Agent permission
model: another Agent of that owner may find/use them; organization membership
does not grant access to another owner's personal Skills. Organization-wide
sharing is not introduced. Formal Registry Skills retain existing organization
read scope and publication permission. Trusted caller context supplies
organization and actor; model/browser inputs cannot choose them.

Projection keys are (organization_id, agent_id, name); different Agents with
the same Skill name remain distinct. Names and digests use package-rules-v1.
A producer assigns a durable, monotonically increasing positive safe-integer
sequence to each source-state event, including removal/revocation. Reconciliation
replays these events without running the learning model again. Removed entries
retain a metadata tombstone so delayed updates cannot resurrect them. A later,
higher-sequence authorized source state may become active again.

## Registry routes

All routes enforce the [Registry authentication profile](service-authentication.md). Body limit is 4 KiB.
Objects reject unknown fields; query is trimmed, nonempty, at most 256 UTF-8
bytes. Search limit defaults to 20, maximum 50. A zero explicit limit is invalid.

| Method and route                         | JSON input      | Success                    |
| ---------------------------------------- | --------------- | -------------------------- |
| PUT /internal/skill-projections          | projection      | 200 projection_result      |
| POST /internal/skill-discovery/search    | search_request  | 200 search_response        |
| POST /internal/skill-discovery/load      | load_request    | 200 exact verified ZIP     |
| POST /internal/skill-projections/promote | promote_request | 201 existing version shape |

Mapping updates are serialized per key. Same sequence and same fields replay;
same sequence with changed fields is request_conflict. Older sequences return
superseded with the current sequence, without modifying it. No artifact or body
is accepted by the projection route.

Search first selects bounded literal case-insensitive name/description matches
from formal heads and source mappings. It does not add a vector service or
popularity ranking. Source candidates are owner-scoped and active. An internal
`search_request` may additionally carry `requesting_agent_id`, derived
by ACP from the persisted active Run, never supplied by the model. The Registry
excludes that Agent's personal projections **before candidate limit selection
and source inspection**: a foreground caller cannot acquire its own idle
maintenance slot. Formal versions remain eligible even if originally promoted
from that Agent. Local Skills stay available through normal Runtime reads.
Console owner discovery omits this context so it can preview/promote its own
sources. This field narrows candidate selection; it grants no authorization or
new sharing scope. Explicit null/empty/noncanonical IDs are invalid_request.
A bounded
source inspection verifies current existence, read permission and metadata;
unavailable inspection is source_unavailable, not an empty successful result.
Missing or unauthorized source entries are omitted. The index can lag; refreshed
source metadata is authoritative and only still-matching results are returned.
Sorting is deterministic by name, kind and source identity. Filtering may
produce fewer than limit results; there is no pagination.

Loading formal refs reads exact Registry-owned versions. Loading Agent refs
checks the mapping and calls the source artifact endpoint with the selected
sequence/digest. Source authorization is checked on each fetch. An older ref,
changed bytes or sequence is content_changed (409), requiring a fresh choice.
Removed/unreadable refs use the same not_found (404) response. Source content
unavailability is 503, never a stale Registry copy. Retrieved bytes are validated
under package-rules-v1 and actual name/digest checked before any body is served.
Load responses include Content-Type application/zip, Content-Length,
ETag, X-Antnest-Artifact-Digest and X-Antnest-Content-Digest.
They have Cache-Control: no-store; transient request buffers do not become
Registry-owned projected assets. JSON errors expose no body or source URL/token.

Promotion is an explicit authorized user operation. Only an Agent ref is
accepted. The caller derives current Registry publishing permission before
dispatch; promotion also requires source read permission. Registry first checks
the organization-scoped command receipt. Identical replay returns the committed
version without consulting a changed/deleted/unavailable source; changed input
is request_conflict. New requests fetch the selected complete package and check
its current source sequence, digest and shared format before publishing.

No target means create; appending requires both skill_id and expected_version,
keeps the same package name and follows the existing name uniqueness/CAS rules.
Fingerprint binds action=promotion, organization, actor, source ref/digest,
target and expected version. Existing upload and promotion receipts share one
request namespace. Version, receipt and source provenance commit atomically.
Promotion is the point at which Registry takes complete package custody and
formal version lifecycle ownership. Source edits/removal no longer affect it;
the original Agent package remains Agent-owned. Templates consume only formal
skill_id+version refs, using the existing create/rebuild read-only delivery.

## ACP-owned source routes

Registry uses one configured ACP origin, never a caller-supplied download URL.
Two private endpoints require Registry's own workload credential for ACP,
scoped to these read routes only; use the dedicated service header and an
ACP-specific outgoing file, with no user CCT or legacy source token.
Source inspect accepts at most 8 KiB JSON; source artifact requests at most
4 KiB. The larger inspect bound accommodates 50 maximum-length source keys.

| Method and route                      | JSON input              | Success               |
| ------------------------------------- | ----------------------- | --------------------- |
| POST /internal/skill-sources/inspect  | inspect_request         | 200 inspect_response  |
| POST /internal/skill-sources/artifact | source_artifact_request | 200 exact current ZIP |

Inspect receives at most 50 distinct Agent/name keys. It resolves **current**
Agent existence, ownership/read access, managed source state and content
metadata. It returns active authorized requested entries only, including their
current sequence. Source-service storage is read through this API, not through
a cross-service database query or volume mount.

Artifact repeats current access/source checks and compares selected sequence
and expected_digest. It returns the same ZIP headers as load plus
X-Antnest-Source-Sequence matching the selected sequence. The read must obtain
one internally consistent package; unknown/drifted content is not replaced by
a historical candidate. No new Run or model inference is started for these
read routes. Runtime availability requirements are source-owned, not inferred
from Registry's directory. ACP requires an available, accepting source Runtime
and an idle source Agent. Busy/offline/unknown reads
return source_unavailable without replaying a model or substituting candidate
bytes. A signed read-only observe checks the full current directory manifest;
matching content-addressed applied bytes can then be served. Extra files or
changed modes also invalidate the selection. Source access, binding and managed
identity are rechecked after observation. Reads and catalog refreshes share idle
admission with learning; foreground preemption discards delivery and awaits an
already dispatched bounded read.

Normal Disable preserves owner access and the managed content identity, but
removes the available Runtime binding: current source search/load return
source_unavailable (503), never retained candidate bytes. Enable restores reads
only after the new Runtime binding and full current manifest have been verified;
unchanged content retains its source sequence/digest. Delete removes current
Agent access: old source refs are immediately not_found (404), current search
omits them, and the producer eventually delivers a higher-sequence tombstone.
Formal versions and installed presets remain independently readable throughout
these source lifecycle operations. Tests exercise these through normal
Controller operations, without directly changing producer or Registry database
state.

Registry has a 10-second per-source-request timeout, refuses redirects,
caps inspect responses at 128 KiB and ZIP at 8 MiB, propagates cancellation,
and returns bounded errors. Invalid source JSON/header/ZIP is source_invalid
(502); upstream missing/denied becomes not_found; changed selection is
content_changed; other transport/availability failures are source_unavailable.
Search checks current metadata; load/promotion independently check current bytes.

## Model tools and temporary Runtime use

find_skill input is query plus optional limit; load_skill input is skill_ref
plus expected_digest. ACP derives tenant/actor from the active Run and adds
these platform tools through an explicit catalog/dispatch contract. They grant
no Registry publishing authority and do not modify Template or AgentSpec.
The ACP-owned [tool contract](../agent-acp/skill-discovery-tools.md) defines
reserved identities, Session permissions, durable request budgets, result
scope and read-only recovery. Text results alone do not imply file delivery.

Temporary use is **Run-scoped**. Text enters that Run's tool result/context.
Packages that need paths are delivered as **real files** into a Run-owned
temporary Runtime directory, validated before use. **No symlinks**, cross-Agent
volume mounts, changes to the system /skills volume or permanent personal-Skill
registration are permitted. Once acquired, source updates do not rewrite the
Run's bytes. This does not freeze the entire workspace or forbid ordinary edits.

Runtime implements the separate [private delivery/cleanup contract](../runtime/temporary-skills.md)
and [wire schema](../runtime/temporary-skills.schema.json). ACP's file delivery
and durable Run cleanup consumer is defined in the
[temporary consumer contract](../agent-acp/skill-temporary-consumer.md),
including completion, cancellation, normal restart recovery and subsequent Run
admission.
Storage is bounded by the existing per-package limits,
at most four packages and 128 MiB unpacked per Run. Delivery uses the Runtime
single execution slot and ordinary UID 1000 file ownership; it does not expose
a maintenance tool to the model. Completion/cancellation closes temporary use
and performs idempotent cleanup. While a temporary scope is active, new Bash
calls are foreground-only: Runtime stops remaining subprocesses from that
invocation before returning a settled result, regardless of command spelling,
cwd or script use. Existing unrelated background jobs are preserved. Long-running
use needs a durable installation/preset. Runtime's named-volume tests cover
path handling and cleanup after normal shutdown/restart. Durable private files
remain outside this feature.

Trace records use bounded source refs/digests and outcomes; no package bodies or
dialogue evidence is captured. A search hit or successful Run is not proof of
Skill quality. Registry unavailability does not undo completed learning or
prevent already installed local/system Skills from being used.
The [HTTP Trace boundary contract](trace-boundaries.md) defines Registry context
extraction, actual source CLIENT propagation, native export and graceful shutdown.

## Errors and testing

Existing errors/status mappings remain. New codes are content_changed/409,
source_unavailable/503 and source_invalid/502. Missing permissions/existence
share not_found; wrong service credentials return service_unauthenticated/401. Provider error
bodies/URLs and database secrets are never forwarded.

Registry tests cover metadata-only persistence, update/replay/removed order,
cross-owner/org rejection, current-source checks, digest drift and offline
failure, promotion rollback/CAS/idempotence and independent formal reads after
source removal. The complete dual-Agent learning → projection → temporary use →
promotion → Template/rebuild workflow is covered by the
`make e2e-skill-propagation` Docker E2E target.
