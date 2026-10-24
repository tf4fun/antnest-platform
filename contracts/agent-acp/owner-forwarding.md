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

## Remaining transport and integration batches

HTTP connection handles must retain the original registration/incarnation/epoch,
SDK connection ID and authenticated identity. Existing POST/GET/DELETE go to that
original transport owner; DELETE does not require a current live execution lease.
Cleanup cannot be answered by a new owner or fabricated from a stopped-process
proof. New execution and original-connection cleanup are separate admissions.

HTTP/SSE, state/control/source forwarding, deceased-member takeover, and actual
two-replica Docker acceptance remain required. A WebSocket Prompt passing alone
does not complete #49. Acceptance includes both protocols, bidirectional
permission traffic, cancellation, revoked access, held original cleanup, and
failure/unknown-result paths before the final multi-replica integration.
