# Agent UI workspace API v1

This document defines the HTTP and SSE API between the Workspace browser
application and the Agent UI Node Bridge, reached through Edge Gateway. The
route catalog is [`workspace-api.json`](workspace-api.json); browser-safe wire
values are [`workspace-api.schema.json`](workspace-api.schema.json). The Node
implementation and Gateway routing are checked against both. Service ownership
is described in the [Agent UI architecture](../../services/agent-ui/docs/architecture.md).

## Authority and identity

The public prefix is `/api/app/workspace/v1`. Gateway authenticates each request,
enforces the CSRF token on POST, and overwrites all internal identity headers.
Gateway checks `Origin` only when the request supplies it: a present `Origin`
must match the Gateway origin, and an absent one is not rejected. Node receives
organization, principal, user and membership in trusted headers, plus a
verified administrator flag for `/bootstrap`. For Agent-scoped paths
(`/agents/{agentId}/...`), Gateway also sets `X-Antnest-Agent-ID` from the
path; Node requires the Organization, Principal and Agent headers and rejects
an Agent-scoped request without them. Node then verifies Agent and Session
access through its upstream calls. Gateway overwrites the
flag from the resolved Identity principal; a browser-supplied value is never
forwarded.
Neither path, body, cursor nor `Idempotency-Key` can select an identity. All
reads, cached views, idempotency hits and SSE resumes repeat scope checks. A
scope is `(organization, principal, agent)`; a Session adds its Session ID.

`GET /bootstrap` and Workspace SSR additionally require the verified
Organization slug/name supplied by Gateway revision 14. Their transport is one
canonical, unpadded Base64URL UTF-8 value in each of
`X-Antnest-Organization-Slug` and `X-Antnest-Organization-Name`. Missing,
duplicate or malformed values return `401` before discovery. The browser-safe
principal has required `organizationSlug` and `organizationName` strings;
these are display facts only. The Node handler, shared schema, frontend mappings
and SSR/hydration use the same principal without a placeholder fallback. A new
authenticated bootstrap observes current Identity metadata without resetting
an unchanged ID-based scope. See [Organization projection](organization-projection.md).

The browser receives no ACP connection identifier, provider credential, Runtime
address, internal access token, trusted identity header or raw admin audit
record. `contentBlock` values are the user's negotiated ACP content and must be
validated by the SDK adapter; the generic shared schema is only their
browser-safe outer boundary. Configuration options and Usage retain the current
ACP semantics, including unknown values. No timestamp is fabricated for replay
messages lacking one.

## Routes and responses

Workspace control commands use the [control-command contract](workspace-commands.md).
Agent View's `controlCommands` advertises currently available workspace controls,
including commands usable without a Session. `POST /agents/A/commands` dispatches
them without a model Prompt or Run; command feedback is transient. Configuration
CAS, targeted Stop and exact Session ownership continue through existing operations.
Native Session `availableCommands` retains its separate ACP meaning.
Agent View `skillCommands` supplies the current Agent's discoverable preset and
personal Skills, including before a Session exists. Discovery, naming and normal
Prompt invocation follow the [Skill command contract](../agent-acp/skill-commands.md).

The machine-readable catalog maps every route to its request/response schema.
All paths in that catalog are relative to the prefix. Path IDs are opaque and
must be URL encoded as individual segments; a decoded slash or separator cannot
escape the selected route. `GET /bootstrap` supplies principal discovery and
`renderedAt` for SSR/hydration. Document selection follows the
[workspace navigation contract](workspace-navigation.md): `/workspace/{agentId}/`
and `/workspace/{agentId}/sessions/{sessionId}`. No route mutation occurs during SSR.

`GET /agents/A/sessions` keeps ACP's cursor semantics. An incomplete page never
proves that a previously observed Session was deleted. `POST /agents/A/sessions`
uses `/workspace` cwd and no client MCP servers. Its response loss is ambiguous:
refresh the directory before any user-initiated retry. Session creation has no
cross-restart idempotency promise in v1.

`GET /agents/A/view` returns an Agent projection. Its optional `sessionId`
query selects a Session; without one, `selectedSessionId` and `selectedView`
are null while Agent availability, active Session, operation and permission
summaries remain visible. `availability` and `activeSessionId` come from the
authorized ACP Agent execution-state read. A failed read returns an error
instead of inventing a ready/offline state. The response includes a
`streamCursor` for the same Agent and selection. The `operations` and
`permissions` arrays cover the selected Session, ACP-reported active Session,
and other Sessions with locally tracked live intents or pending permission
requests. An older operation not discoverable in that set remains available
through its direct operation URL; the arrays are not an archive of every
Session. Entries retain their `sessionId`, and the Bridge must not hide a
running operation merely because a different Session was selected.
The [Skill learning contract](../skill-learning/learning-api.md) defines the
optional `systemNotices` Agent View field and corresponding delta path. Node
populates it from SDK `notice` updates plus bounded learning-record recovery. The
Node/FE projection carries the committed record's `changeId`, `sequence`,
`agentId`, `kind`, `occurredAt`, `skillName` and `changeSummary`, with optional
source Session/Run identifiers. Notice delivery does not
advance ACP transcript output watermarks or create a model message.
`promptCapabilities` projects only the SDK's negotiated image, audio and
embedded-context booleans. The browser uses them for attachment admission;
missing values mean unsupported. Internal ACP capabilities and metadata are
not exposed.

`GET /agents/A/sessions/S/view` returns one selected Session projection, up to
20 recent completed turns plus one active turn, authoritative operation and
permission state for that Session, and its `streamCursor`. Required nullable
`title` and `updatedAt` carry the latest authorized ACP Session metadata through
HTTP and SSE; `null` means not known, and the browser must not replace an
unknown server timestamp with its local clock. These fields remain available
on blocked Views. `historyToken` binds the scope, Bridge epoch, Session
incarnation and ACP `appendVersion`; it is an opaque condition, never an
authentication credential. A cold/unavailable view has null append version,
output watermark and history token; submission stays disabled until a
validated condition arrives. A cursor is bound to its identity, Agent, selected
Session, fixed history cut and projection version. Old or foreign cursors fail
or cause an explicit reset; they never revive retired state.

`availableCommands` is the latest Session-scoped ACP command catalog, projected
as `{name, description, input?: {hint}}` without ACP `_meta`. An empty list clears
the previous catalog. Both ordinary `available_commands_update` notifications
and the catalog accompanying a delivery checkpoint update this metadata; the
checkpoint must still advance/seal delivery normally. Commands do not create
turns or change the history condition. HTTP Views and SSE deltas carry the same
catalog, and retained-byte accounting includes only its current replacement.
Command names are nonempty tokens without whitespace or `/`, and unique within
the catalog. The browser must not borrow commands from another Session/Agent.

The composer filters the advertised catalog while a leading `/` token is being
entered. Arrow keys navigate; Enter or Tab completes; Escape dismisses. Selecting
a candidate edits the draft without sending it, and argument hints remain
visible. IME confirmation and Shift+Enter retain their normal editing behavior.
Unrecognized text continues through the normal Prompt path. An unsent new
conversation has no native Session catalog yet; it still exposes the Agent's
`controlCommands` for help, status and navigation. Discovering either catalog
does not create an empty Session.

Protocol-valid history and active output are retained completely. Cumulative
conversation size is not an admission rule and must not clear history, clip
output or disable the next prompt. Byte metrics describe retained current
entities, including replacements and replay candidates, not accumulated wire
traffic. Resource controls apply to concurrent loads and disposable delivery
queues. Unobserved, idle Sessions are released independently after five minutes;
active Runs, including recovered Runs, interactions and replay work prevent
retirement. Rematerializing a Session creates a new incarnation. Read cursors
from a retired incarnation cannot recreate or mutate that old incarnation.

When a replacement replay fails after a sealed Session View was already
available, the Bridge may return `historyState: "blocked"` with that retained
history after a fresh access check. Its `appendVersion` and `outputWatermark`
describe the retained history cut; current operation and permission summaries
may be newer. `historyToken`, `configurationToken`, and `olderTurnsCursor` are
null, so the browser presents the old turns read-only and offers an explicit
retry. A cold Session with no sealed view still returns a retryable error.

Turn pages contain at most 20 logical turns ordered oldest to newest. A Session
View advertises `olderTurnsCursor`; each `turnPage` returns `nextCursor` for the
adjacent older page and `newerCursor` for the adjacent newer page. Either is
null at its end of the Session. `GET .../turns` without a cursor returns the
latest page. Both directions use the same scoped endpoint; the opaque cursor
encodes its direction and is bound to the View's output watermark. This lets a
client discard distant pages and later fetch them again in either direction
without retaining their content. A client that retained earlier turns across a new
watermark must start from the new View cursor, skip matching turns while
reestablishing the page boundary, and reject a gap it cannot prove contiguous.
The stable `turnId` comes from persisted Run/message identity, not array order.
`turn.contentCursor` is non-null when
prompt/final response content is not fully inline. `turn.contentSection` is
`prompt` or `finalResponse` to identify which visible message owns that
continuation; it is null exactly when `contentCursor` is null. The browser
offers the full-content action on that message only. A `contentPage` identifies
its `section` (`prompt` or `finalResponse`) and returns complete ACP blocks in
order without mixing sections within one page. When prompt continuation ends,
`nextCursor` advances to any remaining final response content. If one serialized
block exceeds the page byte budget,
`fragment` carries an exact base64 slice of that JSON block with byte offset
and total length. Clients reassemble all bytes before parsing and applying
the negotiated ACP block validator. `complete: false` and non-null `nextCursor`
mean the response is intentionally partial. The service cannot mark a preview
as complete. Process pages contain at most ten logical items and 256 KiB;
each item includes only its bounded inline content. An item with remaining
content exposes `contentCursor` for `GET .../turns/{turnId}/process/{itemId}/content`.
That response returns whole blocks or an exact serialized-block fragment with
offset and total length, and `complete` becomes true only after all content is
read. Process page and item cursors bind the selected turn, item, process
version, identity and fixed output watermark. The browser follows distinct
advancing process cursors until the advertised item count is reached, without
an additional cumulative page-count limit; repeated cursors and duplicate
items remain invalid.
While a turn has `outcome: running`, its `processVersion` and `processCount`
also drive the live presentation: the browser opens the process by default,
fetches advancing process pages automatically, and refreshes them when the
version changes. A user may fold the live process, which stops its in-flight
reads; reopening resumes from the current View. Completed turns retain the
explicit, on-demand history behavior. On a running-to-terminal transition the
browser keeps the observed process open for a reader away from the bottom and
may fold it when the reader is at the bottom. Live process bodies remain bounded
by the same item content cursor rather than being inlined into every View/SSE
update.
For a running turn, `liveProcessDelta` may provide at most ten current process
items with their stable zero-based indices. `fromVersion` is the oldest prior
`processVersion` from which those items cover every intervening process change;
multiple changes to one index are represented by its latest item. A browser may
apply the delta only when it has the complete process for a version at least
`fromVersion`, all existing identities still match their indices, and new items
append contiguously to the advertised `processCount`. Otherwise it must reload
the process through the versioned pages. The current producer publishes only
the latest process change, covering the immediately preceding version, or
coalesces up to eight consecutive changes to the same process item. A change
to another item resets that window. The producer omits the delta after an
unrelated transcript change. This keeps an unchanged large process body out
of later small updates; a skipped version outside the window reloads through
the pages. The delta is also omitted if its public payload would exceed the
budget. Completed turns never carry this live field.
For a tool process item, `toolSections` identifies the content block indices
of its optional current raw input and raw output, followed by additional tool
content at `detailStartIndex`. These indices refer to the complete item content
across inline and continuation pages; omitted input/output do not create
placeholder blocks. The browser keeps these sections inside one tool card and
preserves `pending`, `running`, `completed`, `failed` and `unknown` status.
For a standard ACP plan item, the first text content block contains the JSON
array of complete SDK plan entries (`content`, `priority`, `status`); the browser
renders it as a Plan with progress and entries, including after continuation.
The browser owns each expanded turn's process requests separately from ordinary
View/history requests. A View revision that leaves that turn's process version
and item count unchanged must not interrupt its in-flight process page or item
content read. Folding the turn, changing its process identity, switching history
pages or closing the selected Session aborts those requests; a late response
cannot repopulate released process content.
The browser's ordinary JSON deadline includes response-body reading and settles
even when an underlying fetch ignores abort. It distinguishes a deadline from
caller cancellation. Process and full-content read failures keep already loaded
material visible and offer an explicit retry; timeout copy remains distinct from
other failures.

`POST .../prompts` requires a client-generated stable `intentId`, the same
`Idempotency-Key`, an immutable `expectedAppendVersion` in the body and a
current `If-Match: <historyToken>`. The successful `202` means **Bridge
received**, not **ACP accepted**. The publicly queryable operation ID equals
the intent ID. `GET .../operations/{intentId}` is a read-only recovery query;
it works after a new Bridge epoch under current authorization without the old
history token. If its durable receipt is missing after a possible dispatch, it
returns `uncertain`, never an assertion that the prompt did not run.
Terminal failed operations expose the durable, bounded `errorClass` from the
ACP Run receipt. The browser maps known classes to actionable, non-secret copy;
unknown classes retain a generic failure message. This applies to both live SSE
updates and an operation reread after reload.

The Node service keeps work alive after the HTTP handler or browser disappears.
Ordinary browser JSON requests have a 30-second total response deadline; Node
has 60 seconds. SSE and ACP Run execution have separate lifetimes. On command
timeout or lost response the client queries the original operation and never
silently changes the intent ID. A user-directed retry obtains a current
history token but keeps the original immutable append version and identical
content. ACP resolves a duplicate receipt before considering new admission;
otherwise its append CAS decides whether that old intent may be admitted.

`POST .../operations/O/cancel` carries `expectedRunId`; O remains the intent
ID. Cancellation must target that Run through ACP's durable state and in-memory
supervisor, so a delayed Stop cannot affect a later Run in the same Session.
If a terminal receipt is observed while cancellation is in flight, its terminal
phase wins over a late cancellation response. A recovered operation without a
local receipt rereads its durable outcome before the Bridge returns a
`cancelling` phase; missing receipts remain `uncertain`.
Configuration applies only a server-advertised select string or boolean value
with the opaque
`configurationToken` from the current view; response loss is reconciled by reading the current
configuration, not replaying an old selection. Permission decisions carry
the exact currently advertised `permissionId`, option and generation; stale
generations fail without choosing a default answer. The browser may retain
drafts and attachments while mounted but does not persist unsent work.

The error envelope has stable `code`, non-secret `message`, `requestId`,
`retryable` and a `recovery` action. Baseline statuses: 401 unauthenticated,
403 denied (with existing existence-hiding rules), 404 absent, 409 conflict,
413 too large, 422 unsupported content, 428 missing append condition, 429
capacity, 503 unavailable and 504 ordinary request deadline. An exhausted
replay queue is `replay_capacity_exceeded`; a stream snapshot or live
selection over budget is `stream_capacity_exceeded` and requires a fresh read.
A new scope denied because every Bridge owner slot is busy receives
`bridge_capacity_exceeded`; a cold owner may be retired to admit it.
A missing/expired durable
receipt stays unknown. `retryable` never authorizes automatic prompt replay.
When the producer confirms that a selected Session is absent or invisible, its
Agent/Session View, event stream, history, operation and configuration routes
return `404 session_not_found` with
`retryable: false` and `recovery: "none"`. The browser ends that selection and
returns to the Agent directory; transient observation failures remain
retryable. A missing intent receipt is still `uncertain`, not Session absence.

The Node HTTP request reader has a 64 MiB absolute ceiling, while Prompt
admission uses the ACP POST body ceiling (16 MiB by default). Before returning
`202`, Node must check the serialized ACP `session/prompt` request including
its intent metadata against that configured ceiling; an oversized Prompt
returns `413 request_too_large` without reserving an operation. The Node and
ACP containers receive the same deployment value when this ceiling is
overridden. This is independent of the retired browser WebSocket path. Values
in the route catalog are initial configuration defaults.

## SSE envelope and handoff

One EventSource observes the selected Agent, the operation and permission
coverage defined above, and the selected Session's history. The optional
`sessionId` query chooses that history; no selection still yields Agent events.
`snapshot` and `reset` carry `agentView`, including its nullable selected view.
Its `projectionId` includes the selected Session; switching selection creates a
new projection.
`streamRevision` is an Agent subscription sequence, separate from each
Session's `viewRevision`. A `delta` carries `sessionId`, `incarnation`,
`fromSessionViewRevision` and `sessionViewRevision`; all four are null for an
Agent-only selection. The browser requires the same selection/incarnation and
the exact preceding Session revision before applying the event atomically.
Its `patch` contains 1–128 JSON Patch operations (`add`, `replace`, `remove`)
against the retained **Agent View**, limited to availability, active Session,
prompt capabilities, operations, permissions and mutable selected-view fields.
Identity, selection, epoch and incarnation cannot be patched. Prototype paths
are forbidden. Add/replace require a value; remove has no value. Array indexes
and JSON Pointer escaping follow JSON Patch semantics. A failed operation or
invalid resulting projection rejects the entire event and requests a reset.
The Agent cursor advances to the envelope cursor; Session `streamCursor` remains
its separate Session journal cursor and is not patched. Ordinary changes use
delta; unchanged views publish nothing. Reset is reserved for initial sync,
incarnation replacement, gaps, slow observers or deltas exceeding 64 KiB.
Operation and permission changes travel in the same atomic delta as the
corresponding selected-view summary, rather than separate uncoordinated events.

The Node owner takes an atomic snapshot cut and registers its suffix before
returning the snapshot cursor. The first EventSource connection can pass that
cursor as a query parameter; automatic reconnect uses `Last-Event-ID`.
Contiguous retained events use `fromStreamRevision → toStreamRevision`.
Duplicates are ignored, while a gap, expired suffix, changed epoch or changed
projection receives `reset` plus a fresh snapshot. A cursor is only a resume
hint. The browser must rebootstrap after an EventSource error to distinguish
network failure, 401 login expiry and 403 access revocation; it stops
reconnecting on the latter two. Gateway's existing Agent-state SSE behavior
is separate and still rejects `Last-Event-ID` until its own contract changes.

Each subscriber has a 1 MiB pending-byte limit. Replaceable updates may be
coalesced; operation terminal facts and permission inbox remain in the next
snapshot. A stalled observer gets reset/disconnected without delaying ACP.
Each owner admits at most 16 live Agent SSE subscriptions across all selected
Sessions, and retains at most 32 Agent selection journals plus 32 Session
snapshot journals. Each journal retains at most 256 KiB of replay suffix.
When a journal limit is reached, an unsubscribed journal may be retired; a
subscribed journal is protected and new demand gets
`429 stream_capacity_exceeded` if none can be retired. An expired suffix
causes a fresh reset snapshot. These caps are separate from retained
history, so tab count and old SSE cursors cannot silently consume unbounded
owner memory.
The initial heartbeat interval is 15 seconds. Gateway must revalidate the
original Identity session within a maximum five-minute lease, including when
no business events arrive, and must forward flushes without SSE buffering.
Disconnecting an observer never cancels an ACP Run.

## Related contracts

The ACP extension is specified in
[`../agent-acp/workspace-bridge.md`](../agent-acp/workspace-bridge.md).
The active Gateway route contract is
[`../edge-gateway/session-contract.json`](../edge-gateway/session-contract.json).
The Node Bridge and business HTTP/SSE routes are the only Workspace path. The
Gateway route contract and ACP extension are verified together with the
browser workflow.

The contract integration test lives at
[`../../tests/integration/agent-ui/fullstack-contract.test.mjs`](../../tests/integration/agent-ui/fullstack-contract.test.mjs).
Service unit and component tests stay with their service; real stack checks
live at root `tests/e2e/`.

A delta additionally carries `fromCursor`, the opaque Agent View cursor before
its patch. This allows the browser to apply the first SSE delta directly to its
HTTP snapshot, without decoding a signed cursor or requiring a redundant reset.
It must equal the retained Agent View cursor. Once the stream projection is
established, both cursor and stream revision continuity are checked. HTTP reads
publish any new state into that same journal before issuing their snapshot cut.

The optional `learningStatus` Agent View field and delta path carry the minimal
owner-scoped learning blocker from the learning contract. `null` means no
current authoritative read; `{agentId, blocked:null}` means a successful read
with no blocker. The status Agent must match the enclosing View. Read failures
must not become a success notice or an authoritative empty status. Only an explicit `GET /agents/A/view?learningStatus=1` requests
a diagnostic read (coalesced for five seconds); the optional `sessionId` selection retains its usual
semantics. Duplicate or other `learningStatus` values are invalid. Ordinary
View reads, SSE refreshes and runtime sweeps do not query learning status.
The browser requests it once when the user opens learning results, cancels its
read on close/Agent switch, and never adds a timer or automatic retry loop.
