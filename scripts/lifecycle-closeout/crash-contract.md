# Runtime reconstruction crash integration

This opt-in diagnostic runs only in a fresh Foundation Compose project. It
does not enter the stable graceful-restart profile or alter service code.

The public Rebuild must reach a persisted Runtime Update before the real
Runtime Controller process is killed. A transparent Docker socket proxy holds
either the target create request (source already removed), or the successful
target start response (target exists, operation not yet committed). The proxy
matches the exact Agent and owner scope; it never manufactures Docker results.
Agent Controller and Temporal remain running.

After restarting the same Controller container, Temporal must retry the same
child request, request digest, target revision, generation and spec digest.
Only one target is created/started, the workspace bytes survive, and one new
execution revision, one updated observation and one rebuilt event are published.
The public exact-request replay must leave physical state and events unchanged.

Raw traces are retained, including spans lost by the deliberate SIGKILL. The
successful recovery path is checked separately. Any interrupted spans excluded
from that scoped check must be individually recorded; the full trace must never
be reported as strictly passing. Successful-path gaps, unrelated missing parents,
unexpected errors and wrong retry identities remain failures. Clock findings
remain diagnostics. Teardown must remove only the disposable project's assets.
