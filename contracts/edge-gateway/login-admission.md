# Login admission

The [policy](login-admission-policy.json) defines the Gateway's cheap login
prefilter for [#2](https://github.com/tf4fun/antnest-platform/issues/2). Its
baseline is Gateway session version 22; activation belongs to the owning
Gateway version 23 implementation. This shared batch leaves the active catalog
at version 22. Gateway implementation, consumer reference updates and real
HTTPS/OIDC integration remain pending; this document alone enables no behavior.

Identity's [password policy](../identity/password-verification.md) remains the
authority for persistent credential attempt limits and bounded Argon2 work.
Gateway admission is local to one process, is lost on restart and does not
provide a distributed quota or a process RSS guarantee.

## Independent budgets and configuration

| Flow           | Tables consumed by one admitted request | Limit variables and defaults                                            |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Password login | `password_sources`, `password_accounts` | `ANTNEST_EDGE_LOGIN_SOURCE_MAX=30`, `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX=10` |
| OIDC start     | `oidc_sources`                          | `ANTNEST_EDGE_OIDC_START_SOURCE_MAX=30`                                 |

All windows use `ANTNEST_EDGE_LOGIN_WINDOW`, default `5m`. Each of the three
tables has its own `ANTNEST_EDGE_LOGIN_MAX_KEYS` bound, default `65536` entries.
Limits and table sizes are positive integers; the window is a positive Go
duration. Unset or whitespace-only environment values use defaults. Explicit
non-positive, malformed or overflowing values fail startup. Constructor zero
values select defaults and do not provide an environment-level disable switch.

OIDC has no account, organization or Provider bucket. Starts from one source
cannot consume another source's OIDC budget, or either password table. Password
login likewise cannot consume OIDC capacity, including when the email is
`oidc:workforce`. Admission occurs after public Origin and payload validation
but before any Identity call. An allowed request consumes each relevant budget
once; a downstream refusal, error or cancellation does not refund it.

## Keys and trusted addresses

The source input is the already selected client address from
[public entry](public-entry.md). Apply IPv4 unmapping first, then use the IPv4
address or mask IPv6 to its `/64` prefix. Thus `192.0.2.7` and
`::ffff:192.0.2.7` share a source; `2001:db8:1:2::1` and
`2001:db8:1:2::ffff` share a source, while `2001:db8:1:3::1` does not.
Missing or invalid input, including a zone identifier, uses one shared unknown
key. Do not retain arbitrary invalid strings as new keys.

Aggregation affects only admission keys. Diagnostics and downstream forwarding
retain the actual selected client address. Caller-supplied forwarding headers
do not become trusted merely because the limiter can parse them. Source key
content is bounded to 32 bytes, apart from map/list and string object overhead.

The password account key is a 32-byte SHA-256 digest. Normalize each of
`organization_slug` and `email` with Go `strings.TrimSpace` followed by
`strings.ToLower`; this is simple Unicode lowercase, not case folding or Unicode
normalization. Let `LP(s)` be the UTF-8 byte length as an unsigned 64-bit
big-endian integer followed by those bytes. Hash:

```text
LP("antnest.edge-gateway.login-admission/password/v1")
  || LP(normalized organization_slug) || LP(normalized email)
```

Length prefixes keep embedded NULs and component boundaries unambiguous. The
fixed domain prevents a future flow from reusing the password key namespace.
Neither the account map nor its FIFO nodes retain raw identifiers; their memory
use must not grow with the length of the submitted organization or email.
OIDC never constructs or consumes an account key.

## Atomic admission and bounded eviction

Each table has a lookup map and a FIFO ordered by creation of the current
window. Read one admission timestamp after acquiring the admission mutex.
Expiry is fixed at first admitted use plus the configured window; hits and
refusals never extend it. Equality with expiry means expired. Reading the clock
under the same mutex preserves creation/expiry order under contention.

Before changing any table, inspect all relevant live budgets. If the source is
at its limit, reject with `source_limited`; otherwise a password account at its
limit rejects with `account_limited`. A refusal must not increment counts,
remove expired entries, move FIFO nodes or evict an unrelated key. This also
applies when another table is full. Competing requests for the final allowance
cannot both pass.

For an allowed request, prune expired FIFO heads in the relevant tables. When
a new key still needs space, evict the oldest live head and admit it. An expired
key must lose its old node before a replacement window is appended. Existing
live windows stay in place. Increment each relevant budget once in the same
critical section. Maps and FIFOs must remain consistent and each table must
stay within its configured bound; pruning work is proportional to expired
heads, without scanning the complete table on every request.

Eviction deliberately permits an evicted key to start a new window. An attacker
who can introduce more than the table capacity in one window can therefore
reset old Gateway allowances. The larger default and IPv6 aggregation raise
that cost, while preventing a full table from denying every new user. Retained
keys at their limit still reject before eviction. Identity's persisted limits
and resource budgets remain in force; eviction does not reset them. Clients
behind one selected address or IPv6 `/64` still share a source budget.

## Responses and metrics

Gateway refusal preserves the existing HTTP `429` body with only
`code: login_rate_limited` and `message: Too many login attempts`. It makes zero
upstream calls, uses `Cache-Control: no-store` and never writes or clears a
Cookie. `Retry-After` is the entire configured window, rounded up to positive
integer seconds, not a remaining-window estimate. In particular, a positive
subsecond window has `Retry-After: 1`.

An admitted password request continues through the separate Identity failure
contract: validated `credential_rate_limited`/`credential_busy` retain their
429/503, bounded retry hint, `no-store` and unchanged Cookies. An upstream
failure does not cause another admission decision or replay of the request.

The counter `antnest_edge_login_admission_total` increments exactly once when
admission is consulted, with only `flow` and `outcome` attributes:

- `flow` is `password` or `oidc_start`.
- `outcome` is `source_limited`, `account_limited`, `evicted` or `admitted`.
  Source refusal takes precedence when both password budgets are exhausted;
  OIDC cannot emit `account_limited`.
- An admitted request that evicts one or both live table heads emits one
  `evicted` decision. Expired-head pruning alone emits `admitted`. There is no
  separate eviction-event counter in this policy.

No address, organization, email, Provider, key hash or arbitrary attribute may
be attached. Malformed requests rejected before admission do not increment this
counter. Export follows the existing opt-in OTel metrics configuration.

## Delivery and admission

1. This shared policy and its contract tests precede service changes.
2. The Gateway batch activates version 23 with its implementation, operations
   and architecture docs, and unit/contract/component/owning-container evidence.
   It covers flow isolation, normalized and delimiter-safe keys, IPv6 aliases,
   full-table eviction, expiry/recreation, atomic refusal, concurrent final
   allowance, configuration validation and exact metric/HTTP/upstream counts.
3. Consumer version references follow the owning Gateway batch. Preserve the
   historical #60 password policy activation at version 22.
4. Cross-service Docker admission uses two actual client container IPs behind
   the trusted HTTPS proxy and the test Identity OIDC Provider. Exhausting source
   A's OIDC start allowance must leave source B able to finish signed SSO. Two
   browser contexts with the same network source are insufficient evidence.

The issue remains open until those batches and the applicable final CI pass.
