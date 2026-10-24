# ACP Fixed Membership Assignment (#49)

This planned batch follows [peer publication](owner-peer.md). The
[deterministic vectors](owner-assignment-contract.json) define the first
two-process startup and distribution stage. Service wiring and actual two-process
acceptance remain required; this contract alone does not enable shared startup.

The complete pinned catalog determines each Agent's preferred member. Sort its
member IDs by ascending ASCII order. Encode `[organization_id, agent_id]` with
JSON.stringify, without Unicode normalization, then SHA-256 the UTF-8 bytes.
Interpret all 32 digest bytes as one unsigned big-endian integer; its remainder
modulo catalog size selects the preferred member. Incarnation, peer origin,
startup order, process-local health and lease contents do not change this result.
The catalog must contain 1–64 unique valid member IDs. Capture the catalog and
scope before asynchronous work; caller mutation cannot change the selection.

The initial distribution stage acquires and recovers only the preferred member's
scopes, including inventory-only Agents no longer in a publication. It must not
ignore historical rows, recover another live member's work or acquire a lease
for every Agent merely because it starts first. An absent member stays in the
catalog. Forwarding and stopped-member takeover remain subsequent stages; this
batch does not imply failover or permit a timeout to substitute for revocation.

Legacy and non-peer processes retain the exclusive PostgreSQL advisory lock with
key 2026083002. Registered peer processes may use its shared form only after all
Agent mutations and recovery paths are protected by a current Agent lease fence.
The same key excludes mixed legacy/peer processes while allowing multiple peer
holders. Release joins the original recovery queue, session monitor and unlock.
A shared lock never authorizes the old global Learning recovery helper.

Fenced legacy recovery combines a current immutable Agent registration/fence with
the historical record's original legacy identity: all owner columns remain null.
It uses the ordinary Agent transaction fence and lock order, checks the exact
scope and rejects owned or mixed facts. A non-null scope alone does not mean an
owned historical row. Run, Permission, paused Learning and Temporary cleanup
must use this explicit authority; no fallback to process-local worker authority
is permitted after a lease failure. Fees, unknown effects and Runtime protections
remain durable. Acquiring a lease or a shared startup lock is not proof that a
previous execution stopped; uncertain effects require the existing isolation path.
An active legacy Run has no original registration from which a permanent stopping
proof can be requested. Preserve and protect that scope until trustworthy migration
or stopping evidence exists; do not call ordinary restart recovery to manufacture
`executor_state=quiescent`. Existing Runtime isolation admission itself requires
the executor stopping boundary, so it cannot silently substitute for that missing
proof. Healthy scopes continue independently. This unresolved migration case must
remain visible in delivery and operations evidence.

Startup keeps local restore independent from aggregate ACK: register and pin,
acquire the appropriate compatibility lock, recover local assigned inventory and
restore locally, start the peer listener, then open ordinary listeners/readiness.
Normal Controller publication still requires matching receipts from every member
and the final fenced confirmation. It must wait for original revoked work even
on a member with no currently owned Agent.
