# Platform resource identifiers

This document defines how platform services generate new resource IDs. It is a
generation contract, not an authorization rule or a replacement for
protocol-specific validation.

New platform-owned persistent resources use `<kind>_<32 lowercase hex digits>`.
The kind is a registered lowercase resource type; the suffix represents 16 bytes.
The same complete value is stored, returned by APIs and used in document paths.
Consumers treat IDs as opaque values and never add/remove prefixes or infer
access, ownership, ordering or time from them.

| Owner | Resource kinds |
| --- | --- |
| Agent Controller | `agent`, `provider`, `credver`, `model`, `modelrev`, `template`, `agentspec`, `accessrev`, `execution`, `event` |
| Agent ACP Service | `session`, `run`, `message`, `mcprev`, `checkpoint`, `toolattempt`; internally generated Run correlation `request` |
| Identity Service | `org`, `user`, `membership`, `group`, `groupmembership`, `oidcprovider`, `oidcsession`, `oidcclaim`, `externalidentity`, `authtoken`, `scimtoken`, `event` |
| Runtime Controller | `rtv` (existing immutable Runtime revision format) |
| Skill Registry | `skill` (immutable Skill identity) |

Random IDs use cryptographically secure randomness. Retry-derived IDs retain
their owning operation's stable namespace and key; type spelling is separate
from the derivation namespace. Agent creation uses
`agent_` + first 16 bytes of SHA-256(`agent` + NUL + request ID), including exact
retry behavior. Rebuilds use the same resource kind as creates. Event kinds live
in event payloads, rather than changing the ID's resource prefix.

ACP-derived child records use the first 16 bytes of SHA-256(namespace + NUL +
key), prefixed with their resource kind. Forked messages/checkpoints derive from
the destination Session plus sequence; the record ID and any payload message ID
must agree. Retry/recovery derives the same value for the same logical record.
Fork/recovery must preserve order, replay content and deduplication.

Generation tests enforce the format at each owner and the kind requested by
each creation path. Consumer schemas accept bounded opaque IDs; they must not
depend on a peer's prefix or reject an already-issued identifier. Existing
records are immutable identities and are never rewritten. There is no URL
alias, read-time conversion, dual-write or compatibility mapper.

Trace/span IDs, external Provider response/tool-call IDs, protocol connection IDs,
process incarnation/Bridge epoch IDs, client idempotency keys, content hashes,
opaque credentials, revision counters and user-managed slugs/keys retain their
own semantics and formats. In particular, token record IDs are distinct from
the secret token bytes; ID generation never alters credential generation.

Agent UI, Admin Console, Edge Gateway and Antnest Runtime are opaque-ID
consumers.
