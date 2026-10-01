# Runtime temporary Skill delivery

This contract extends the [discovery boundary](../skill-registry/discovery-api.md)
with real package files for the current foreground Run. Runtime owns the
producer endpoints. ACP is the only consumer; its foreground install, durable
cleanup and recovery behavior is defined in the
[temporary consumer contract](../agent-acp/skill-temporary-consumer.md). The
text-only `find`/`load` tool results do not invoke this interface by
themselves.

## Private authority and transport

The only public model tools remain ordinary Runtime tools. Temporary operations
never appear in tools/list; tools/call rejects `antnest_skill_temporary_*` names.
Trusted ACP calls `POST /internal/skill-temporary/install` or `/release`.

These endpoints reuse the existing Ed25519 maintenance ticket envelope, verifier
bootstrap and key rotation rules in the [learning contract](../skill-learning/learning-api.md).
The signed action is **temporary_install** or **temporary_release**, so a learning
ticket cannot authorize temporary use and vice versa. For these actions only,
`job_id` is the exact foreground Run ID, not a learning task, and `generation=1`.
The ticket binds Agent, organization, current process execution ID, action,
request ID, exact body hash and existing bounded expiry/skew. Body fields must
match the signed fields. No path, URL, key or caller-selected workspace is accepted.
An absent verifier set disables the endpoint. The existing current/next bootstrap
keys suffice; no RC deployment identity or live key distribution change is needed.

ACP derives this authority from an admitted durable Run, checks current access
before/after Registry I/O, and signs only the selected, digest-verified package.
Runtime enforces execution, signature and local scope, not a second Session ACL.
An old Runtime execution or another Agent's ticket is rejected.

Install is multipart/form-data with exactly metadata and artifact parts; metadata
is at most 4 KiB, artifact at most 8 MiB and the whole body at most 8 MiB + 8 KiB.
Release is application/json, at most 4 KiB. Strict metadata, replies and errors
are defined in the [wire schema](temporary-skills.schema.json). All errors have
bounded fixed messages; no package bytes, credentials or arbitrary upstream
errors are returned. Responses are private and no-store.
Receiving a request body is bounded to 10 seconds, before executor admission;
an incomplete body returns body_timed_out with effect_state=none.

## Real files and quotas

Runtime validates the complete existing package rules and canonical digest,
including CRC, paths, modes and YAML/frontmatter. Under its single execution
slot, the trusted parent invokes a private executor which drops to UID 1000
before touching workspace files. Installation uses real regular files and
directories, atomic publication and read-back; no symlink or cross-Agent mount.

The reserved workspace namespace is `.antnest/skill-temporary/v1/`. A scope key
hashes Agent, current Runtime execution and Run; the package key is the complete
content digest. A returned path has the form:

```text
/workspace/.antnest/skill-temporary/v1/<scope SHA-256>/<content SHA-256>/package
```

Private receipts are siblings of package, so they are not part of the Skill
manifest. `v1` describes only this temporary storage layout, not Registry's
layout_version, package_rules_version or a learning prompt version. The namespace
is reserved for temporary use and is removed on Runtime startup before readiness.
It is not a personal Skill directory, template reference or backup restoration source.

Only one Run may own temporary files in an Agent Runtime at a time. A Run gets at
most four unique packages and 128 MiB unpacked, retaining the existing per-package
32 MiB/256-entry limits. At most four distinct install request IDs are admitted,
matching the foreground load budget; exact retries do not consume another ID.
Retries of the exact installed content verify receipt and
actual complete files instead of copying again. A new load request may reuse the
same content. Reusing a request ID for different content/artifact, or modified/
missing installed files, yields request_conflict; no silent
overwrite or fallback to another digest. Quotas are verified against actual
retained packages. Receipts do not provide a content history or rollback facility.

The paths work with normal read and foreground Bash tools and their existing
Session permissions. Ordinary edits are allowed; installation does not freeze
the workspace. While a temporary scope is active, Bash invocations are
**foreground-only**: the supervisor stops remaining subprocesses from that
invocation before returning. If a background process remained, the call reports
temporary_background_not_supported with a settled effect after proven stop;
if stop cannot be proved it reports an unknown effect and closes admission.
This applies regardless of whether a path is spelled in the command, supplied as
cwd, or used by a script. Existing unrelated background tasks are not killed.
Long-running work needs a durable personal installation or template preset.
Managed MCP remains ordinary tools; this contract promises file cleanup, not
erasure of data already read into another process's memory or arbitrary copies
the user explicitly creates.

## Completion, cancellation and recovery

Release closes the exact Run scope and removes only its reserved temporary tree.
It is idempotent even when no package exists. Closing a Run prevents an in-flight
or delayed install ticket from recreating the scope. Runtime serializes install
and release through its existing execution slot; runtime_busy is a retryable
pre-dispatch refusal, not a completed write. Closed scope identities are kept for
121 seconds, covering the existing maximum signed-ticket lifetime and skew, with
at most 1024 identities; saturation refuses new temporary scopes until expiry.
Ordinary tools do not depend on this bounded private admission cache.

Normal Run completion/cancellation requires ACP to release before another Run or
learning maintenance is admitted. ACP restart must reconcile all pending scopes
from its durable Run/cleanup state, including a lost install response. Runtime startup clears inherited temporary
trees before readiness, and normal Runtime shutdown cleans after owned execution
and managed processes have stopped. A crash may leave bytes until the next
startup; old execution-bound tickets cannot restore them in the new process.

Successful install/release has effect_state=settled and runtime_call_stopped=true.
Pre-dispatch rejection has effect_state=none. After dispatch, uncertain file effect
is unknown; responses never claim none merely because transport was cancelled.
ACP must not reuse the read-only recovery shortcut of the text discovery tools
for this write boundary.
Executor install is bounded to 60 seconds and release to 30 seconds; shutdown cleanup uses
a bounded private executor. Failure to prove cleanup does not produce an installed
result or a successful release receipt.

## Testing and tracing

Runtime coverage includes unit and strict shared-wire tests; Linux executor
tests for real files, exact retry/conflict/quota and safe cleanup; and disposable
Docker named-volume/HTTP tests for signed current/next keys, actual read and Bash
use, background work via cwd/script, completed/cancelled cleanup and restart with
old-ticket rejection. Traces record bounded Run/source digests and outcomes,
never package bodies.
