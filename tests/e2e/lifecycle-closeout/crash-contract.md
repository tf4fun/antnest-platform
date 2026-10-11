# Runtime reconstruction crash contract

This document defines the opt-in Runtime reconstruction crash diagnostic
(`make e2e-lifecycle-crash`). It runs only in a fresh Foundation Compose project,
is not part of the stable lifecycle targets and does not change service code.

## Fault injection

The public Rebuild must reach a persisted Runtime Update before the real Runtime
Controller process is killed. A transparent Docker socket proxy holds either the
target create request (the source is already removed) or the successful target
start response (the target exists but the operation is not yet committed). The
proxy matches the exact Agent and owner scope and never manufactures Docker
results. The Agent Controller and Temporal keep running.

## Required behavior

After the same Controller container restarts, Temporal must retry the same child
request, request digest, target revision, generation and spec digest. Only one
target is created and started, the workspace bytes survive, and exactly one new
execution revision, one updated observation and one rebuilt event are published.
The public exact-request replay must leave physical state and events unchanged.

## Trace rules

Raw Traces are kept, including spans lost to the deliberate SIGKILL. The
successful recovery path is checked separately. Any interrupted span excluded
from that scoped check is recorded individually, and the full Trace is never
reported as strictly passing. Gaps on the successful path, unrelated missing
parents, unexpected errors and wrong retry identities are failures. Clock
findings are diagnostics. The diagnostic target can exit 2.

Both recovery phases retain the original public Rebuild's `console` admission.
Its sole raw `gateway.identity.resolve` decision must survive the verified
recovery projection and complete before the actual Gateway-to-Console CLIENT.
The `rpc/cache/shared` source obeys the shared cache budget and exact successful
Identity CLIENT/SERVER/SQL receipt rules. A hit does not require a new Identity
SERVER, and a shared waiter must archive and validate its actual source and any
refresh trigger. Unknown Resolve fields in excluded spans still fail.

The crash collector applies the existing projection only to this current raw
trace. External source and trigger traces require complete parent chains; they
cannot inherit the killed Runtime process's missing-parent or error exception.
The canonical `{trace_id}.json` files always contain raw snapshots, including
excluded spans. Collection converges over three identical complete raw closures,
so late diagnostics reset stability even when span IDs are unchanged. Reports
retain the current crash diagnostics separately from full-closure error and
warning counts and remain strictly failed. Cancelling the actual Foundation run
joins the active Jaeger request and response body.

These local consumer gates do not replace the opt-in Docker crash scenario or
the separate #59 HTTPS outage/load integration. Ordinary collectors still reject
all missing parents, including the unrelated #247 diagnostic.

Teardown removes only the disposable project's resources.
