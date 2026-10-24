# ACP Owner Peer Publication And Routing (#49)

This extends [Agent ownership](agent-ownership.md) and
[incarnation handoff](owner-handoff.md). The [operation manifest](owner-peer-contract.json)
and [closed wire schemas](owner-peer.schema.json) define the first ACP peer batch:
local publication/revocation receipts and the aggregate Controller ACK.
Peer production also uses [fixed membership assignment](owner-assignment.md)
and shared compatibility locking; non-peer mode retains the exclusive lock.
Two real-main processes are covered with controlled dependency peers. Forwarding,
genuine two-replica failover and Docker integration remain required delivery gates.

## Trusted membership and process binding

ACP receives an immutable operator-owned projection of the Runtime Controller
member catalog: a cluster UUID and at most 64 unique member IDs with unique,
canonical private peer origins. Platform container selectors stay with Runtime
Controller. Peer origins contain no userinfo, path, query or fragment; redirects
are not followed. Request bodies, CCTs, lease rows, historical Runs and returned
receipts cannot supply a destination. The local registered member must occur once.

`membership_sha256` is SHA-256 of the UTF-8 canonical JSON projection. Canonical
JSON recursively sorts object keys, preserves array order and otherwise uses JSON
string/number encoding; membership members are sorted by member ID first. All
members must compute the same digest. Do not silently drop a member after an RPC
failure or lease expiry. Changing the roster requires retiring the previous
roster's registrations and access holders; a different local file is not that
proof. The initial implementation rejects a changed roster without that migration.
The ACP database pins the complete canonical catalog and its digest in one
immutable singleton row, independent of cluster ID. A restart must compare that
row even when peer configuration is absent; removing configuration cannot bypass
an existing pin. A first initialization is atomic with its comparison, and a lost
completion does not authorize clearing the committed row or trying a new roster.

The separate private peer listener accepts only explicitly granted ACP workload
operations. It is distinct from ordinary workspace/control listeners and the early
Runtime Controller incarnation probe. Workload identity alone does not establish
which member is involved: the client connects to the configured member origin and
checks that member's locally registered tuple. The receiver uses its own immutable
startup registration, never a caller-provided replacement for its identity. The
operator projection must bind the same member/container network origin used by
Runtime Controller registration; no load-balanced or request-selected peer target
is admitted. An unrelated member cannot provide another member's local receipt.

Identity discovery echoes a fresh 32-byte random challenge and the request ID,
returns only the receiver's registered tuple, and checks the membership digest.
The subsequent publication names that exact target registration/member/incarnation;
a restart between discovery and publication rejects the old target. The source
registration must be a catalog member and must match the authenticated private
peer context. Incarnation IDs, challenges and fingerprints are not credentials.
Payloads and credentials are not logged or captured as trace content.

The initial peer token profile uses a dedicated credential for each directed
source-member/target-member pair and the existing service authorization header.
The receiver derives the source member from its trusted credential-hash mapping
before reading the body; the body cannot select that identity. This authenticates
the member, not the claimed source incarnation or lease epoch. Execution authority
still requires the receiver's fixed registration and the final sealed-authority and
lease checks. Ordinary service credentials and service-only certificate identities
do not grant access to this peer listener.

The receiver file is a closed mapping from every other catalog member ID to one
current SHA-256 token hash and optionally one next hash (`sha256:` followed by 64
lowercase hexadecimal characters). Missing or unknown members, duplicate JSON
keys, duplicate hashes and a local-member entry reject startup. These member
grants are separate from the ordinary logical-service caller file. Outgoing token
files are addressed only by validated catalog member IDs in a separate private
directory and are reread on every request. A missing or invalid file never falls
back to the previous token. TLS still validates the destination hostname and ACP
service URI; in mTLS mode the receiver additionally verifies the ACP client
certificate, and the dedicated member token remains mandatory.

## Local publication receipt

The entrypoint first persists the authenticated private configuration as today.
The peer request carries only organization, revision and `authority_sha256`.
That digest covers canonical JSON of the complete parsed private configuration,
including credentials, owner/principal scope, Runtime binding, lifecycle operation
and policy. Hashing only the public projection is insufficient. Each receiver reads
and authenticates its own sealed copy from PostgreSQL and verifies the exact digest
and revision before applying it. A newer payload cannot reinterpret an older receipt.

Peer application is a leaf operation: it publishes locally, prepares only the
locally owned accepting Agents, applies access changes to every local holder, and
returns its own receipt. It never calls aggregate ACK or contacts another peer.
This prevents recursive publication and self-join. The public entrypoint remains
the sole aggregator; its Controller response DTO is unchanged.

`status=applied` means the exact local publication is visible and every listed
Agent has a usable prepared graph under the recorded registration and canonical
decimal lease epoch. Epochs are in `[1, 9223372036854775807]`; duplicate Agent IDs
and inconsistent owner tuples are rejected semantically even when individual wire
objects are structurally valid. A persisted snapshot or a valid lease alone cannot
produce a ready receipt. A member with no accepting Agent still returns a receipt.

`revocation=joined` means the removed output, permission, state and transport
bindings governed by this publication have stopped and their original cleanup has
joined. A nonowner may retain those bindings from earlier ownership. Such a member
cannot be omitted merely because its current owned-Agent list is empty. An abort
signal, lease expiry, vanished heartbeat or unacknowledged cancellation is not a
revocation receipt. Live members must apply the publication themselves; any use of
an authoritative stopped-incarnation proof to retire an old process must identify
that original registration and preserve the outstanding cleanup boundary.

Transport admission captures the local publication sequence before awaiting
authentication or readiness. A later denying publication for the same organization
prevents that pending request from adopting a resource. Fresh authenticated ACP
connections retain their existing initialize semantics; business operations still
perform Agent authorization. An already retired HTTP handle retains its original
404 traffic response and authenticated 202 DELETE receipt. Publication cleanup
continues to join all existing affected requests and connections.

## Aggregate ACK and deadlines

Capture the exact frozen local publication, authenticated private authority and
complete trusted membership before waiting. Obtain one matching receipt from every
required member, including the local member and nonowners retaining access. The
owned-Agent union must cover every accepting Agent exactly once. A missing member,
unknown owner, duplicate scope, unready graph, unknown revocation, wrong request ID,
changed membership or mismatched registration/revision/digest rejects the ACK.

Network waits occur outside the local publication queue and every database
transaction. Healthy local Agents remain usable when a different owner cannot ACK.
After all receipts arrive, use one finite transaction with the existing order:
organization barrier, sorted Agent lease rows, authenticated sealed authority.
Validate the original full authority and all captured owner epochs/expiries together
after all lock waits. Never replace the expected payload with a newly read one.
Finally require the same local frozen publication object and no pending publication.
Lease/authority change after a peer receipt must therefore reject the ACK.

One absolute request deadline, at most ten seconds, covers identity discovery,
local/peer application, revocation joins and final confirmation. Forward the original
deadline; do not reset a budget per hop or member. Requests have one hop, bounded
bodies and bounded responses. Deadline expiry may end the public wait, but the owner
retains and joins every original RPC/database/cleanup operation before releasing its
resources. Late independent failures stay observable. Returning a timeout does not
prove a side effect stopped. Repeating the same current publication is idempotent;
this does not authorize replay of a Prompt or other business operation.

## Subsequent forwarding and live handoff batch

The Agent UI keeps one ACP origin and Gateway's retired ACP route stays retired.
The ACP ingress resolves the current owner from the trusted membership and current
lease, not from historical Run ownership. The receiving owner revalidates workload
authorization, the original signed CCT, user/organization/Agent scope, request ID,
target incarnation/epoch, and the original absolute deadline. Forwarding is single
hop. Headers supplied by public clients cannot impersonate peer context.

The current Agent owner and the original transport owner are distinct. Existing
stream/connection handles retain their original registration/incarnation/epoch.
DELETE and cleanup route to that original owner and join its original tasks; a new
Agent owner or an RC stopped proof cannot manufacture a successful cleanup response.
Unknown business submission results are never replayed automatically. A definite
pre-dispatch owner mismatch may be re-resolved only within the original deadline;
it is not an unknown result. Public typed errors remain unchanged.

Live handoff is a separate proof kind bound to the original Run, owner epoch and
Runtime binding. It requires the original model/tool/permission and cleanup tasks
to join. It cannot impersonate an RC process-stop proof or infer that remote Runtime
effects stopped. Forwarding, transport cleanup, live handoff, membership deployment
and two-replica failover need their own production admission after this peer batch.

## Required acceptance

The first ACP consumer batch must demonstrate actual peer HTTP publication for two
owners in one organization; a held remote initializer must prevent success ACK;
epoch takeover or a DB-only sealed-authority change after a receipt must reject it;
and a nonowner's held old-stream cleanup must prevent ACK. The final integration
must run different Agents on both replicas, kill one replica, recover under the
documented stop rules without replay, and verify resource cleanup. Schema or unit
tests alone do not establish that business behavior.
