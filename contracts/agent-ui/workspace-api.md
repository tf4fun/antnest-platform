# Agent UI workspace API v1

Status: **implemented shared contract under acceptance**. The browser uses the
Gateway Workspace HTTP/SSE routes. The route catalog is
[`workspace-api.json`](workspace-api.json); browser-safe wire values are
[`workspace-api.schema.json`](workspace-api.schema.json). The Node
implementation and Gateway routing are checked against both. The [full design](../../services/agent-ui/docs/fullstack-bridge-refactor.md)
defines service ownership and acceptance batches.

## Authority and identity

The public prefix is `/api/app/workspace/v1`. Gateway authenticates each request,
enforces CSRF and Origin on mutations, and overwrites all internal identity
headers. Node receives organization, principal, user and membership in trusted
headers, plus a verified administrator flag for `/bootstrap`, then verifies
Agent and Session access through its upstream calls. Gateway overwrites the
flag from the resolved Identity principal; a browser-supplied value is never
forwarded.
Neither path, body, cursor nor `Idempotency-Key` can select an identity. All
reads, cached views, idempotency hits and SSE resumes repeat scope checks. A
scope is `(organization, principal, agent)`; a Session adds its Session ID.

The browser receives no ACP connection identifier, provider credential, Runtime
address, internal access token, trusted identity header or raw admin audit
record. `contentBlock` values are the user's negotiated ACP content and must be
validated by the SDK adapter; the generic shared schema is only their
browser-safe outer boundary. Configuration options and Usage retain the current
ACP semantics, including unknown values. No timestamp is fabricated for replay
messages lacking one.

## Routes and responses

The machine-readable catalog maps every route to its request/response schema.
All paths in that catalog are relative to the prefix. Path IDs are opaque and
must be URL encoded as individual segments; a decoded slash or separator cannot
escape the selected route. `GET /bootstrap` supplies principal discovery and
`renderedAt` for SSR/hydration. The Agent → Session URL remains `/workspace/`
with `agent` and `session` query values; no route mutation occurs during SSR.

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
on limited or blocked Views. `historyToken` binds the scope, Bridge epoch, Session
incarnation and ACP `appendVersion`; it is an opaque condition, never an
authentication credential. A cold/unavailable view has null append version,
output watermark and history token; submission stays disabled until a
validated condition arrives. A cursor is bound to its identity, Agent, selected
Session, fixed history cut and projection version. Old or foreign cursors fail
or cause an explicit reset; they never revive retired state.

If live output exceeds the Bridge history budget after a successful replay,
the selected Session uses `historyState: "view_limited"`. It retains the
authorized `operations` and `permissions` and a complete received
`outputWatermark`, while `turns` is empty, `olderTurnsCursor` and
`historyToken` are null, and submission remains disabled. Required
`limitedPreview` contains at most 4096 characters of displayable recent
output with `truncated: true`; empty text is valid for non-text output. This
preview is explicitly incomplete and cannot become a turn or a full-content
response. History endpoints may return `history_capacity_exceeded` until a
bounded replay succeeds. The Bridge must continue consuming delivery marks
and observing Run and permission state without an unbounded in-memory output
queue; it must not retry an over-budget replay in a tight loop.

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
prompt/final response content is not fully inline. A `contentPage` identifies
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
version, identity and fixed output watermark.

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
history budget is `history_capacity_exceeded`; a stream snapshot or live
selection over budget is `stream_capacity_exceeded` and requires a fresh read.
A new scope denied because every Bridge owner slot is busy receives
`bridge_capacity_exceeded`; a cold owner may be retired to admit it.
A missing/expired durable
receipt stays unknown. `retryable` never authorizes automatic prompt replay.

The Node HTTP request reader has a 64 MiB absolute ceiling, while Prompt
admission uses the ACP POST body ceiling (16 MiB by default). Before returning
`202`, Node must check the serialized ACP `session/prompt` request including
its intent metadata against that configured ceiling; an oversized Prompt
returns `413 request_too_large` without reserving an operation. The Node and
ACP containers receive the same deployment value when this ceiling is
overridden. This is independent of the retired browser WebSocket path. Values
in the route catalog are initial configuration defaults to verify with real
workload before cutover.

## SSE envelope and handoff

One EventSource observes the selected Agent, the operation and permission
coverage defined above, and the selected Session's history. The optional
`sessionId` query chooses that history; no selection still yields Agent events.
`snapshot` and `reset` carry `agentView`, including its nullable selected view.
Its `projectionId` includes the selected Session; switching selection creates a
new projection.
`streamRevision` is an Agent subscription sequence, separate from each
Session's `viewRevision`. A `delta` requires the Session's incarnation and
new view revision. Its `patch` is a bounded JSON Patch subset (`add`, `replace`,
`remove`) against browser-safe selected view fields; the service validates an
allowlist of paths and the resulting projection schema before publishing.
Forbidden fields such as credentials and internal endpoints are never patch
targets. Large responses use reset/snapshot instead of oversized deltas.

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
causes a fresh reset snapshot. These caps are separate from the history
budget, so tab count and old SSE cursors cannot silently consume unbounded
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
The development deployment uses the Node Bridge and business HTTP/SSE routes as
its sole Workspace path. The Gateway route contract and ACP extension are
verified together with the browser workflow.

The contract integration test lives at
[`../../tests/integration/agent-ui/fullstack-contract.test.mjs`](../../tests/integration/agent-ui/fullstack-contract.test.mjs).
Service unit and component tests stay with their service; real stack checks
live at root `tests/e2e/`. Cutover requires local gates and the subsequent
cross-service batches in the design.
