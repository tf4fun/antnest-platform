# Historical Controller Response-Loss Acceptance

Historical status: v1/v2 Docker acceptance passed on 2026-09-10 against the
then-current acquire-run/finish-run APIs. Those APIs and their RPC-only drivers
are retired. This record does not describe current-candidate acceptance.

`make e2e-rpc-response-loss` now runs the [current fixture](../rpc-response-loss/README.md).
See [2026-09-17 revalidation](../../docs/rpc-response-loss-revalidation.md) for
publication/settlement response loss, scoped business evidence and strict Trace
failures. ACP database commit-receipt loss remains pending in its own batch.

## Historical reproduction (retired)

From the platform root, install the locked ACP service dependencies and build
the local Stage 3 images, then run `make e2e-rpc-response-loss`. Do not combine
this flag with another fault profile or `ANTNEST_E2E_KEEP_STACK=true`. Tests use
only synthetic accounts and a deterministic model; no `.secret` is read.

The host starts the stopped ACP container only after observing exit code 1,
no OOM and no platform restart. It verifies the same container ID with a newer
process start time and healthy service. The fixture client has no Docker socket;
it can read only ACP's own test database. Controller state is corroborated by
real RPC responses and Jaeger spans, not cross-service table access.

## Scenario

This is a separate disposable Stage 3 profile. It changes only test routing:
ACP calls a temporary HTTP proxy, which forwards to the real Agent Controller.
Gateway, Console and other services still address Controller directly. The
proxy has no Docker socket, database connection or external credentials. No
production fault-injection switch is added.

For each ACP version, test both committed-response-loss windows:

1. Arm exactly one `acquire-run` or `finish-run` for a specific Agent/Session.
   Forward the original request and trace headers. Read the complete upstream
   response and require HTTP 200 before withholding it from ACP. Keep only
   non-secret identifiers, terminal fields, and canonical request/response
   hashes. Never expose the credential-resolution response or full snapshots.
2. Before dropping the downstream connection, independently read ACP-owned
   durable state. Acquire must still be admitting, without accepted input,
   execution snapshot, model request or Tool; the previously saved Session
   authorization event remains unchanged. Finish must already have the
   completed Run, message and settled Tool, but no local closure confirmation.
3. Destroy that response connection. Observe ACP's own fail-stop exit code 1;
   do not kill it to manufacture recovery. The host alone starts the stopped
   container and verifies a new process and readiness. Checkpoints are bounded
   and scoped to the fresh test project. Never restart an unobserved process.
4. Acquire recovery reuses the same request ID and immutable admission result,
   then performs the first execution exactly once. Finish recovery reuses the
   admission and terminal semantics without reexecuting model or Tools; its
   command request ID may differ. All replay responses must really be received
   successfully, not merely attempted.
   Compare the complete normalized upstream admission hash with ACP's actual
   persisted snapshot, and all Finish terminal fields with its durable Run.
   Two identically wrong reports must not pass. Require a distinct startup
   trace with no inherited Gateway ancestor.
5. Reconnect twice with the official SDK. Preserve ordered persisted user,
   answer and Tool history, successful outcomes, stable IDs and model counts.
   A subsequent Run reads the actual append file: exactly one marker, unchanged
   Runtime, and no leftover busy admission. Each denied/incomplete/faulted
   outcome is distinct from successful completion.
6. Check original Gateway-to-Controller Jaeger ancestry and successful normal
   post-recovery Run ancestry. Startup recovery is a separate trace boundary:
   correlate by persisted request/admission identity rather than inventing a
   Gateway parent. Do not claim unexported spans after process failure.

Verification is serial: pure proxy/oracle tests, real local HTTP tests proving
withholding and dropped bytes, dedicated Docker profile, existing format/lint
gates and documentation checks. Parent cleanup owns all test resources and
publishes final success only after zero owned containers, volumes and networks.
Keep compact final metrics; do not commit intermediate dumps or full traces.

The strict response comparison exposed a production timestamp mismatch:
first AcquireRun returned in-memory nanoseconds, while replay returned
PostgreSQL microseconds. Controller now returns database-materialized admission
timestamps using `INSERT ... RETURNING`; its database regression uses a
nanosecond input and compares the complete first and replayed records.

## Final Result

Four response-loss/restart cases passed: eight Runs, eight real Tools and 16
deterministic model requests. Eight repeat load/resume requests performed no
execution. The configuration response is restored separately from message
history, as defined by the service's load/resume implementation.
Eight original/recovery RPC traces contain 678 spans; four subsequent read
traces contain 852 spans. All resources were removed before publishing success.
The [closeout report](../../docs/docker-single-node-closeout.md#c1-rpc-response-loss-2026-09-10)
records final verification and scope. This does not accept crash-during-rebuild,
browser workflows or the complete operational milestone.
