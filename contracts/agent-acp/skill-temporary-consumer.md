# ACP temporary Skill consumer

This document defines how Agent ACP Service consumes the
[Runtime temporary contract](../runtime/temporary-skills.md) to deliver
multi-file packages for the [Skill discovery tools](skill-discovery-tools.md). Registry keeps
dynamic source mappings; only promotion transfers full package custody. This
consumer never registers a personal Skill or modifies the system Skill volume.

## Foreground dispatch

find_skill remains read-only. load_skill may write its selected multi-file
package into the Runtime's reserved temporary namespace; its catalog therefore
has readOnlyHint=false and retains ordinary Session permissions. A text-only
package needs no filesystem delivery and returns temporary_files=null.

ACP verifies the exact ZIP and rechecks durable Run access before Runtime I/O.
Before installation it persists one cleanup scope per Run, derived from the
active Run/Session and frozen Runtime execution/endpoint. The model supplies no
authority, path or URL. Package bytes are bounded request-local memory and are
not retained in the scope record. Install is signed with the existing verifier
bootstrap and independent temporary_install action. A validated installed
reply returns temporary_files={path, unpacked_size} and the original source
ref/digests/text. It never returns a path for an unconfirmed install.

The dispatch rechecks access after installation; a revoked result is discarded
but its settled file effect is retained for cleanup. Read failures have effect
none. Confirmed writes have effect settled; a lost/invalid install reply has
effect unknown and no stopping acknowledgement. Cancellation cannot turn an
uncertain write into a read-only result. Existing per-Run load budgets still
count failed calls. ACP never automatically redispatches an uncertain install.

## Run completion and recovery

On completion, failure or cancellation, the foreground executor attempts a
bounded, signed release before persisting terminal state and relinquishing its
Agent slot. Release uses worker ownership, independently of the cancelled Run
signal. A validated receipt closes the durable scope and marks only this Run's
platform load calls stopped. It does not settle ordinary Runtime/client tools.
Failed cleanup leaves a durable pending scope and an unresolved Run outcome.

Before accepting any subsequent Run, ACP preempts learning and reconciles all
pending scopes for that Agent. Learning maintenance checks the same durable
pending state before doing model or Runtime work. Lifecycle settlement also
reconciles scopes before reporting settled. Inaccessibility does not permit
silent cleanup success or admission.

Startup Run recovery treats an interrupted load with a persisted scope as a
potential Runtime write, rather than using the read-only recovery shortcut. An ended
Run's pending cleanup is retried by a serial ownership-bound worker, excluding
foreground and maintenance through the existing per-Agent gate. One scope is
processed per pass, with bounded paging and a delay after unavailable/busy work.
No package retention, undo or global filesystem watcher is introduced.

Cleanup uses the currently published binding for the same organization/Agent,
including a lifecycle-closed Agent. If no binding is currently published, it
uses the captured trusted endpoint. A missing old endpoint is never proof. A
ready reply for the same Agent and a new execution proves Runtime's startup
cleanup; a replacement binding must report its exact published execution. This
can close the old scope without sending an old ticket. A different
Agent, invalid status or unavailable endpoint proves nothing. For the original
execution, only an exact validated release receipt closes the scope. Cleanup
is idempotent; a lost release reply may be queried again by issuing another
bounded release for the same scope, never by reinstalling the package.
Cleanup is assembled even when discovery is disabled. A missing signer leaves
the original execution pending; it never sends an unsigned mutation. Ready
replacement execution proof remains usable without the old signing identity.
The cleanup worker does not clear unrelated learning recovery barriers.

Network/body processing is bounded; cleanup has a 12-second outer deadline per
attempt and retries only Runtime pre-dispatch runtime_busy within that deadline.
Pending rows contain scoped identities and target binding only. Source, Run,
content/artifact digests and cleanup outcomes are traced; credentials, ZIP bytes,
Skill bodies and arbitrary upstream messages are excluded.

## Testing

Coverage includes catalog/dispatch tests, strict signed HTTP receipts,
cancel/lost-response and bounded cleanup, real PostgreSQL intent/recovery/admission,
and a disposable deployed dual-Agent model loading and using actual package
files through ordinary read/Bash. Completion/cancellation, ACP restart and
subsequent Run/learning prove cleanup without depending on SIGKILL timing.
