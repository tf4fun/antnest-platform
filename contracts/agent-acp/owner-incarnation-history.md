# ACP Member Registration History

This extends [incarnation handoff](owner-handoff.md) with private discovery of
every original registration for an operator-configured member. The
[manifest](owner-incarnation-history-contract.json) and
[wire schema](owner-incarnation-history.schema.json) define the Runtime Controller
producer. The ACP consumer, survivor takeover and two-replica fault acceptance
remain separate batches. Listing history does not establish that an executor
stopped or that a new incarnation cannot activate.

## Boundary

`POST /internal/acp-incarnations/history` accepts only the authenticated
`agent-acp-service` workload. Authentication precedes body/storage access. The
request carries the catalog `member_id` and an explicit nullable `cursor`.
Controller scope comes from the receiving service configuration. The request
cannot choose a scope, platform selector, destination, nonce, or credential.
Unknown catalog members are rejected before storage work. No user CCT is required.

Objects are closed and duplicate fields are rejected. Query parameters, alternate
methods, encodings and media types do not expand this operation. The original
10-second total budget covers body reads, storage, response delivery and cleanup;
the request limit is 4KiB and the response limit is 32KiB. Responses use JSON and
`Cache-Control: no-store`, with request/response/error payload capture disabled.
Errors reuse the existing incarnation error envelope. Invalid cursors are
`invalid_request`; storage failures are `acp_registry_unavailable`, not empty
history. The handler joins original work after cancellation and never returns a
partial page as successful enumeration.

## Complete Stable Prefix

Each configured scope/member has one permanent random `history_id` and a
contiguous registration sequence. An initial `cursor: null` captures the actual
committed head revision `R`. The response echoes the member, history identifier,
snapshot revision and exclusive `after_sequence` (`0` on the first page).
`items` contains the next `min(64, R - after_sequence)` entries in sequence order.
Every entry contains its sequence and complete original registration tuple;
there is no running/stopped filter, current-only shortcut or age-based pruning.

When the last returned sequence is below `R`, `next_cursor` contains the same
history identifier and snapshot revision, with that sequence as its exclusive
position. Otherwise it is explicitly null. Empty history has revision/position
`0`, an empty array and null next cursor. Creating its private bookkeeping head
does not create an incarnation registration. Its identifier stays stable.

All positions are canonical decimal strings. Both endpoints and consumers enforce
the range `0..9223372036854775807`; entry sequences and continuation snapshot
revisions are positive. A continuation requires `0 <= after_sequence < R`.
The server rejects foreign history identifiers, scope/member mismatches and
revisions beyond the actual head. Cursor identifiers are not credentials.
The consumer starts at zero, keeps the first history identifier/revision, checks
every echo, contiguous sequence and original member identity, and accepts
completion only at `R`. Missing, duplicated, reordered or truncated entries are
failures. Wire shape validation alone does not perform these cross-field checks.

The prefix at `R` is immutable across page retries and concurrent registrations.
A new registration commits after that prefix and is visible to a fresh first
request. It cannot fill a previously absent sequence below `R`. Same-tuple
registration retries retain the original identity and do not increment the
head. Registration insertion, sequence allocation and head advancement commit
under the same scope/member lock; rollback or cancellation leaves no hole.
Independent sequence allocation before commit is insufficient.

An additive migration includes **all existing registrations**, preserving every
original tuple, nonce digest, platform binding and first stop receipt. It assigns
a stable contiguous order within each scope/member; that order is not a claim
about historic wall-clock start times. The migration seeds the corresponding
head and rejects old writers that cannot supply the new sequence. It must finish
before the history route is admitted. Missing migration or storage evidence must
not be presented as an empty history.

## Required Consumer Participation Barrier

History supplies identities for the original `InspectAcpIncarnation` operation.
Only that exact authenticated inspection can supply an immutable positive stop
receipt. Lease expiry, unreachable members, a completed page, an empty local
slot or a history revision do not supply stop proof.

History at `R` also says nothing about registrations after `R`. The ACP consumer
must establish a separate shared participation ledger before any new process
serves business/peer requests or acquires execution leases. Startup activation
and the final publication acknowledgement/takeover transaction serialize on that
same ledger and captured version. A new participant either invalidates the old
capture or activates after the acknowledged transition. Reading RC history again
immediately before ACK is not an atomic barrier. Existing processes without this
participation protocol require an explicit migration/retirement boundary; they
cannot be silently treated as absent. The pinned membership is never shortened
after a timeout, and a stopped proof is never relabeled as a live joined receipt.

The producer can be delivered independently. It does not itself reassign an
Agent, grant a lease, acknowledge publication, replay work or close issue #49.
