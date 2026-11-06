# Contract Conventions

This guide defines the shared wire conventions for #68: field naming,
pagination, optimistic-concurrency preconditions and idempotency. It records
the agreed contract shape; it does not claim any service has completed the
corresponding behavior.

## Schema documents

Every `*.schema.json` document declares draft 2020-12
(`"$schema": "https://json-schema.org/draft/2020-12/schema"`) and a canonical
identifier `$id` of the form
`https://schemas.antnest.dev/<area>/<filename>` where `<area>` is the
contracts-relative directory (Runtime Controller API schemas live outside
`contracts/` and use the `runtime-controller` area). Shared definitions live
under `$defs`; the draft-07 `definitions` keyword is not used. Cross-document
`$ref` values are either relative references or absolute canonical
identifiers.

Descriptor files (`*.json` without `$schema`, such as `control-contract.json`
or `identity-contract.json`) are explicitly not JSON Schemas. They describe
routes, methods and semantics in prose-adjacent structures and may declare a
`conventions` metadata object naming the shared fragments the contract
follows. That metadata is documentation: the authoritative constraint is the
`$ref` an actual schema makes to the fragment, not the descriptor entry.

The shared fragments are [`common/pagination.schema.json`](common/pagination.schema.json),
[`common/precondition.schema.json`](common/precondition.schema.json) and
[`common/idempotency.schema.json`](common/idempotency.schema.json). Services
with narrower historic constraints keep them locally until their migration
batch; a shared fragment must never silently widen or rewrite an existing
request schema that carries different semantics.

## Field naming

Contract fields are snake_case for services and the Admin Console API. The
ACP wire protocol and the Agent UI browser protocol are camelCase protocol
exceptions, recorded as exact `protocol_exception` aliases rather than a
broad exemption.

Two pagination shapes exist and are not interchangeable:

- A **page** lists an `items` array with an opaque `next_cursor` continuation
  token and accepts a `cursor` and `limit` in the request.
- A **feed** is an ordered sequence consumed with `after_sequence` (request)
  and `next_sequence` (response).

A bounded finite collection returned whole — for example a discovery or
resolution result — is neither a page nor a feed; it keeps `items` without a
continuation field and is recorded as a `protocol_exception` (`bounded_items`)
rather than silently taking on a cursor shape. An ordered, epoch-fenced feed
may also carry a typed keyset cursor object instead of an opaque string — the
recovery history feed uses `(occurred_at, history_id)` — recorded as a
`protocol_exception` (`ordered_feed_cursor`) because it is a durable part of
that protocol, not a pending rename.

ACP/Workspace learning change history is another protocol exception: its
sealed, bidirectional feed retains `nextCursor`, `olderCursor` and
`sealedCursor`. These are response protocol fields, not deprecated request
aliases; they must not be collapsed into a forward-only page.

Cursors are opaque and bounded at 4096 bytes at runtime. The schema
`maxLength` is a character bound, which is not sufficient for UTF-8; services
also enforce the byte bound before decoding or repository access. Narrower
protocol-specific public-ID or ASCII constraints remain in force. `limit` is a
positive integer; each service names its own maximum.

## Optimistic concurrency

Mutations that guard a resource revision carry an opaque `expected_version`
string mapped to the owning service's existing revision counter. The service
does not automatically retry a stale version. The shared
`expected_version` shape and the `if_match` strong-tag shape live in
[`common/precondition.schema.json`](common/precondition.schema.json).

For one release the legacy field names `expected_resource_version`,
`expected_revision` and numeric `expected_version` remain accepted on input
as compatibility aliases; a request that sends more than one form is
rejected even when the values agree. `If-Match` carries exactly one strong
quoted resource tag or the body `expected_version`, never both, and weak
`W/` or `*` tags are unsupported.

`common/convention-aliases.json` records every remaining noncanonical field
name occurrence as an exact `{file, pointer, field}` entry. `pending_migration`
entries are a temporary implementation ledger for known service migrations —
they expire after the stated `remove_after` marker and do not mark those
service batches as admitted or complete. `protocol_exception` entries are
permanent protocol shapes, not pending renames.

## Idempotency

Browser-facing write routes accept an external `Idempotency-Key` header;
internal service calls carry `request_id`, which is the idempotency key and
not the tracing request ID. The shared key shape lives in
[`common/idempotency.schema.json`](common/idempotency.schema.json). Replay
retention stays with each owning service. A repeated key with a different
payload is a conflict, and existing keys are never silently regenerated.

## Related conventions

Timestamps are UTC RFC3339. Resource identifier shapes follow
[resource-identifiers.md](resource-identifiers.md) and issue #16. Error
envelopes follow [common/error.schema.json](common/error.schema.json) and
issue #67.

The source PR stack is not a deployment ordering or proof of mixed-version
compatibility. Deprecated request aliases preserve old inputs, not old
response consumers. Canonical-only consumers require their producer batch;
deploy a coordinated version set unless a boundary explicitly provides both
request and response compatibility. Do not infer a safe rolling upgrade from
an accepted alias. Delivery and exact-head remote admission are recorded in
[`TODO.md`](../TODO.md); Docker E2E evidence stays with its dedicated workflow.
