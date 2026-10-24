# ACP owner forwarding (#49)

This extends [owner peer publication](owner-peer.md). Forwarding keeps one Agent UI
origin and does not restore Gateway ACP routing. The complete delivery includes
v1 HTTP/SSE POST/GET/DELETE, v1/v2 WebSocket, state read/watch, settlement and
Registry source operations. Shared persisted Learning/Bridge/audit reads remain
local. Registry inspection batches must preserve their per-Agent results.

## WebSocket delivery batch

`UPGRADE /internal/acp-peer/forward/ws` exists only on the authenticated peer
listener. Ordinary service credentials cannot authorize it. The initial request
carries the original signed `Antnest-Caller-Context` and exactly one
`Antnest-ACP-Forward` header: canonical base64url UTF-8 JSON, at most 16 KiB,
with this closed shape:

- `request_id`: fresh UUID v4; `deadline_at`: original UTC admission deadline,
  at most ten seconds from the ingress admission, never reset by another hop.
- `membership_sha256`, `source`, `target`: the existing pinned membership digest
  and complete original/target registration tuples.
- `publication`: the complete private authority digest and revision, as in the
  publication contract; no private configuration is sent on this wire.
- `identity`: `organizationId`, `principalId`, `agentId` from authenticated CCT.
- `epoch`: canonical current Agent lease epoch; `protocol`: `v1` or `v2`;
  `caller`: `agent-ui`; `hop`: exactly `1`.

Ingress checks current configured access before resolving the preferred member.
It discovers that member's registered identity over the fixed authenticated
origin and matches it to a live current Agent lease. It never acquires ownership,
scans a healthy subset, or forwards to a URL from a request or lease row.

The receiver validates the authenticated source member, exact target registration,
catalog, deadline, original caller grant and signed CCT again. It then compares
the actual prepared generation and lease epoch, its frozen local publication and
the authenticated private PostgreSQL authority. Each subsequent business dispatch
stays bound to this original generation; a connection cannot silently move to a
replacement generation. CCT expiration still rejects new methods while replies
to already accepted permission requests may settle.

The private WebSocket is an envelope channel. A `frame` carries a canonical
base64 payload and binary flag; user JSON is never interpreted as peer control.
This preserves all ACP methods, replies, notifications, permissions and message
IDs through the existing owner SDK. `close` requests closure of that original
SDK connection. Only the receiver may send `joined` with the original request ID,
after its original SDK completion and connection tasks have joined. A socket
close without this receipt is an unknown cleanup result, never successful cleanup.
Ingress retains its original sends, public socket, peer socket and cleanup receipt
for revocation and shutdown. Admission deadlines do not terminate accepted long
Prompts or extend per-message authorization.

There is no automatic retry of business frames, including after timeout or
disconnect. A peer request ID is correlation, not durable Prompt idempotency.

## HTTP/SSE batch contract

HTTP remains v1 and retains the public
`/v1/acp` POST/GET/DELETE semantics, JSON-RPC messages, permission replies and SSE
notifications. The owning SDK continues to manage its connections and queues.

The optional peer listener admits exact POST/GET/DELETE requests at
`/internal/acp-peer/forward/http`. New POST admission carries the existing closed
forwarding envelope with `protocol: "v1"`, the original CCT and directional
member authentication. It resolves and validates current ownership once, using
the same full authority checks as WebSocket creation. The owner captures that
fence in the HTTP connection binding. Every later business dispatch uses this
captured fence; forwarding never acquires or repairs a lease.

Every HTTP connection created in peer mode, including one created at its local
owner, returns an authenticated opaque `Acp-Connection-Id`. Clients retain and
return that header unchanged. Its canonical format is
`acph1.<base64url nonce>.<base64url ciphertext-and-tag>`, bounded to 4096 ASCII
bytes. It uses the existing shared ACP encryption key and AES-256-GCM SecretBox,
with the fixed, versioned associated data `antnest:acp:http-owner-handle:v1`.
The closed plaintext binds version 1, membership digest, complete original
owner registration, epoch, original SDK connection ID, organization, principal,
Agent and v1 HTTP protocol. It contains neither a target URL nor a CCT. The
ten-second creation deadline is not the connection lifetime: live connections,
idle retirement and bounded cleanup receipts retain their existing transport
lifetimes. Key or membership changes never silently rebind an existing handle.

Subsequent POST/GET/DELETE requests may enter any configured replica. That ingress
authenticates the ordinary workload and CCT, authenticates and validates the
handle, and checks its complete identity. It routes only to the handle's original
member and registration through the fixed catalog. It must not resolve the
current lease, choose another live member, retry business payloads, or replace
the handle after a failed owner connection. The receiver verifies member
authentication, the original CCT, membership and registration again. Only its
original SDK connection may consume the decoded ID. The validated adapter first
copies rawHeaders into its Fetch Request; the original connection then replaces
that Request's ID before calling SDK. Changing only Node's parsed headers would
be insufficient. The creation response exposes only the opaque handle, including when
creation and subsequent requests use different ingress replicas.

Relay bodies and responses as streams. Preserve the ACP content type, accept,
connection/session IDs, cache policy, retry hints, authentication challenges and
response status; strip hop-by-hop headers, Host
and the incoming service credential. SSE admission transfers socket ownership
away from the peer JSON request deadline. The initial absolute deadline bounds
admission, not an accepted SSE stream or long Prompt. Each ingress retains and
joins the original request, response reader, upload and downstream write tasks.
`Acp-Session-Id` must reach the owner unchanged: connection and session SSE
streams are distinct, and session messages and permission responses also use
that field. A connection-level receiver cannot substitute for a session receiver.

Public DELETE still requires its original authenticated identity and CCT, and
the existing empty-body validation. It addresses the original transport without
requiring a current execution lease. Preserve the SDK's 202 close receipt,
unknown-ID 404, duplicate-close rules and receipt window. A newer owner or a
stopped-process proof cannot supply an old connection's cleanup receipt.

Each ingress retains a scoped record only while it owns an original request,
upload, reader, send or cancellation task. Completion of its last actual task
releases that local record; it does not assert remote SDK cleanup. A different
ingress can continue using the original handle. Shutting down one ingress must
not close an idle connection still used through another ingress.

Active relay requests sharing one opaque handle use one ingress connection quota
slot, including simultaneous connection/session SSE streams and POSTs. A new
connection reserves a slot before contacting its owner. The slot is released
after the last original local task joins; independent cleanup failure retains it.
The original owner separately accounts for its SDK connection lifetime.

Service-initiated revocation cancels and joins each member's local non-DELETE
relay tasks. The owner separately retires its SDK connection and joins SDK,
connection tasks and non-DELETE handlers. Both are part of that member's local
publication barrier, and the external publication acknowledgement requires every
configured member's matching receipt. No extra private HTTP close operation is
needed. CCT expiry cannot prevent this local service cleanup. DELETE handlers
are excluded from their own SDK cleanup join and retain the bounded receipt
window during drain.
The private peer listener preserves that same five-second window for authenticated
original-handle DELETEs, rejects new execution, and joins admitted DELETE cleanup
before closing its listener and sockets.

Independent local cleanup failures remain scoped and block later revocation or
shutdown even after the original connection's receipt expires. Public DELETE
still requires the original owner's 202; disconnect, timeout, 404 or a newer
lease never substitutes for it. The aggregate publication binds currently
identified registrations; it does not prove cleanup of a historical incarnation.
That history and stopped-member proof remain part of the later takeover batch.

Acceptance includes actual two-process HTTP single-entry Prompts and SSE
notifications, moving an existing handle to another ingress, permission and
cancel traffic, tampered/foreign-scope handles, DELETE after execution lease
loss, held cleanup preventing revocation ACK, and retained cleanup failures.

## Remaining transport and integration batches

HTTP connection handles must retain the original registration/incarnation/epoch,
SDK connection ID and authenticated identity. Existing POST/GET/DELETE go to that
original transport owner; DELETE does not require a current live execution lease.
Cleanup cannot be answered by a new owner or fabricated from a stopped-process
proof. New execution and original-connection cleanup are separate admissions.

HTTP/SSE forwarding is wired into the production composition. Its candidate still
requires complete remote admission. State/control/source forwarding,
deceased-member takeover, and actual two-replica Docker acceptance remain required.
A WebSocket Prompt passing alone
does not complete #49. Acceptance includes both protocols, bidirectional
permission traffic, cancellation, revoked access, held original cleanup, and
failure/unknown-result paths before the final multi-replica integration.
