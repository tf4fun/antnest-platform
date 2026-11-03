# ACP error classification, version 1

The [catalog](errors.json) and its [schema](errors.schema.json) define the
language-neutral error classification for #53. Catalog keys are stable public
string codes. Each entry supplies its class, JSON-RPC code, HTTP status,
retryability, recovery guidance, safe English message and applicable surfaces.
An optional `retry_after_ms` supplies the default backoff delay.

This shared contract is a separate delivery phase. Completing it does not
complete ACP producer mappings, Agent UI retry behavior, Gateway consumption or
the cross-service user workflow. Those implementation and integration batches
remain pending; the contract alone does not advertise a running capability.

## Capability and compatibility

A conforming ACP producer declares the same capability in the top-level
`initialize` result for both v1 and v2:

```json
{
  "_meta": {
    "antnest.dev/errors": { "version": 1 }
  }
}
```

The catalog's `schema_version: 1` describes the file format; its
`capability.version: 1` identifies these public mapping and retry semantics.
Producer capability advertisement and consumer support remain pending.

Clients that read only `data.code` can continue reading the existing registered
string codes. Numeric codes change from the previous generic `-32020` mapping
to the class-specific mapping. The producer release and ACP protocol changelog
must announce that change as error capability version 1. This does not add a
legacy negotiation or alternate mapping layer.

A new client must not infer automatic retry from a numeric code or string code
when the producer has not declared this capability. With the capability, it
must still follow the entry's recovery guidance and the operation's admission
or accepted-Run state.

## Classification and reserved codes

| Class                                      | Allowed JSON-RPC codes                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `access`                                   | `-32019` through `-32010`                                                    |
| `availability`                             | `-32039` through `-32030`                                                    |
| `configuration`                            | `-32049` through `-32040`                                                    |
| `conflict`                                 | `-32059` through `-32050`, or `null` for non-admission surfaces              |
| `request`                                  | `-32700`, `-32600`, `-32601`, `-32602`, or `null` for non-admission surfaces |
| `internal`                                 | `-32603`                                                                     |
| `authentication`, `dependency`, `resource` | `null`; these entries have no admission surface                              |

The conflict range is an explicit additional reservation for configuration,
idempotency, Session, permission and cursor conflicts. Multiple string codes
may intentionally share a numeric code within their class; `data.code` retains
the specific reason. A `null` JSON-RPC code means that the entry applies to an
HTTP or Skill-source surface without assigning a JSON-RPC admission code.
Every entry with the `admission` surface requires a numeric code.

`not_found` applies to HTTP control queries and Skill-source reads. Both use
HTTP 404, the fixed message `Resource was not found`, and non-retryable
`refresh` guidance. It does not identify whether the missing resource is an
organization, Agent or Skill source, and never grants JSON-RPC admission or
automatic Prompt replay. Skill-source consumers must retain the string code
and recovery policy instead of relying on the earlier source-specific message.

Generic `-32020` belongs only to the fallback below. `-32022` and `-32023`
belong only to terminal outcomes. None of those codes is available to catalog
admission entries.

## Retry and recovery

The five JSON-RPC admission entries with default `retry_after_ms: 1000` are
`agent_busy`, `session_busy`, `configuration_not_ready`, `agent_preparing` and
`recovery_pending`. The HTTP-only `connection_quota_exceeded` entry uses the
same delay for a rejected connection handshake. These six entries use
`retryable: true` and `recovery: "backoff"`.
A delay must be a positive integer no greater than 60000 and cannot accompany
`retryable: false` or a recovery mode other than `backoff`.

The [connection admission contract](connection-admission.md) scopes
`connection_quota_exceeded` to establishing a new connection, before any ACP
command is accepted. It has no JSON-RPC admission mapping and does not permit
replaying an accepted Prompt, model request or Tool effect. ACP enforces shared
HTTP/WebSocket quotas before connection admission. Immutable admission indexing,
performance and multi-replica ownership remain separate delivery work in #49.

`permission_timeout` is the `availability` admission/HTTP mapping `-32039`
with HTTP 408 for a permission request that reached its approval deadline
under the [connection liveness contract](connection-liveness.md). Its
`refresh_permission` recovery carries no `retry_after_ms`: retry means
requesting permission again or submitting new eligible work, never replaying
an accepted Prompt, model request or Tool effect.

`retryable: true` is not permission to immediately replay every operation.
`wait_binding` waits for an available binding, `wait_rebuild` requires the
Runtime rebuild barrier, and `reconnect` requires a new usable connection.
Other guidance such as `query_intent`, `refresh_permission` and `resync`
requires that recovery step before any eligible new admission. Access,
configuration and request failures follow their listed non-retry behavior.

An accepted Run must retain its original identity and receipt. Admission retry
must not rerun its prompt, model or Tool effects. Unknown commit or effect
outcomes require confirmation through the owning operation's recovery path;
they must not be converted into a new Run by this catalog.

## Safe messages, data and fallback

JSON-RPC error data uses
`{code, retryable, retry_after_ms?, details?}`. The schema's `errorData`
definition rejects undeclared fields. `budget_exceeded` with `retryable: false`
may carry `details: {budget: {scope, limit, used}}`; all three fact fields are
required and no additional fields are permitted. `scope` is `run_input`,
`run_output`, `run_cost`, `organization_daily`, `organization_monthly`, or
`unknown_cost`. Amounts are canonical nonnegative decimal integer strings (tokens
for input/output, USD microdollars for cost), or `null` when unknown. Strings
preserve values above the JavaScript safe integer limit; clients must not coerce
them to floating point. Older errors without details and empty details remain
valid. Raw causes, credentials, Provider payloads and exception objects must not
appear there. Only validated facts from a typed budget error or durable terminal
outcome are projected. Malformed facts are omitted without changing the canonical
error classification.

Budget rejection before acceptance remains JSON-RPC `-32043`. An accepted Run
ending with `budget_exceeded` keeps terminal `-32022` (failed) or `-32023`
(unresolved), with the same optional budget details. ACP v2 acceptance is already
complete when asynchronous execution stops; its original output stream/replay
carries the persisted final assistant notice, without a late admission error.
Public messages use the catalog's fixed safe English strings rather than
arbitrary exception text. HTTP status is catalog metadata for the applicable
HTTP route; this contract does not introduce a separate general HTTP envelope.

An unknown or unclassified error uses the required fixed fallback:

```json
{
  "json_rpc_code": -32020,
  "http_status": 500,
  "data_code": "internal_error",
  "retryable": false,
  "recovery": "contact_operator",
  "message": "Agent request failed"
}
```

`data_code` supplies the fallback's public `data.code`; it does not require
exposing the unknown original code or cause. Fallback cannot suggest replay,
replace a known terminal outcome or override an existing Run receipt.

## Accepted Run outcomes

`terminal_outcomes.failed` remains `-32022` and
`terminal_outcomes.unresolved` remains `-32023`. Both are
`retryable: false`, have only the `terminal` surface, and retain the catalog's
safe messages. Their `data.code` vocabulary remains open to the owning Run
outcome classification. Those classifications are not admission codes or
instructions to replay an accepted Run.

## Common error metadata

Version 1 keeps the outer JSON-RPC envelope numeric (`code`, `message`, `id`)
unchanged; the common error contract lives inside `error.data`. Producers now
attach the five common fields — `code`, `category`, `message`, `retryable` and
a request-id-safe `request_id` — to every public error data payload, alongside
the existing bounded `retry_after_ms` and trusted `details.budget` members.
`category` and default `retryable` come from the shared registry
(`contracts/common/errors.json`); explicit legacy retry overrides remain valid
where a producer preserves a pre-existing retry policy (for example peer
`internal_error`/`deadline_exceeded` staying `retryable: true`, or a Runtime
temporary `outcome_unknown` HTTP body carrying `retryable: true` despite its
`internal` registry default). Receivers must treat the metadata as advisory
evidence, not a new retry instruction.

For N/N-1 compatibility, the Skill-source artifact failure keeps its exact
two-field nested `error: { code, message }` alias next to the new five-field
top-level common body; either form alone remains valid for an N-1 consumer.
Consumers that shipped before this producer — Agent UI (PR #512) and Skill
Registry (PR #513) — validate the common metadata conservatively and must not
require it. Final integration still needs to sync the terminal ACP-owned
registry rows into the Agent UI consumer slice; that is deferred to the
explicit integration batch rather than this producer batch.

## Pending owning batches

ACP must consume the catalog in DomainError defaults, both protocol mappers,
applicable HTTP/RPC and Skill-source mappings, and the capability declaration.
Its protocol documentation must link this contract and announce the numeric
mapping change. Agent UI must consume the declared retry and recovery policy;
Gateway must preserve the applicable public status and error fields. Separate
integration must prove that a busy second Prompt can retry after the first Run
finishes, while denied requests stop and accepted effects are not replayed.
