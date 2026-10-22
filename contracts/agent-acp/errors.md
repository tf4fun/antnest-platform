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

Only these five entries carry the default `retry_after_ms: 1000` policy:
`agent_busy`, `session_busy`, `configuration_not_ready`, `agent_preparing` and
`recovery_pending`. They use `retryable: true` and `recovery: "backoff"`.
A delay must be a positive integer no greater than 60000 and cannot accompany
`retryable: false` or a recovery mode other than `backoff`.

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
definition rejects undeclared fields and permits only an empty `details`
object: no detail fields are currently approved. Raw causes, credentials,
provider payloads and arbitrary exception objects must not appear there.
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

## Pending owning batches

ACP must consume the catalog in DomainError defaults, both protocol mappers,
applicable HTTP/RPC and Skill-source mappings, and the capability declaration.
Its protocol documentation must link this contract and announce the numeric
mapping change. Agent UI must consume the declared retry and recovery policy;
Gateway must preserve the applicable public status and error fields. Separate
integration must prove that a busy second Prompt can retry after the first Run
finishes, while denied requests stop and accepted effects are not replayed.
