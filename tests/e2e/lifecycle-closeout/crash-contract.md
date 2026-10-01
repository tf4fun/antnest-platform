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

Teardown removes only the disposable project's resources.
