# Model calls

Each OpenAI-compatible adapter call makes one Provider request. The ACP Run path
can retry the same model under the policy frozen in its execution snapshot.
Provider clients own credentials and revocation; attempts retain the original
Run, input, model parameters and deadline. Retrying a model call never resubmits
the original Prompt or creates a new Run.

An explicit Agent publication field `model_retry` maps to
`snapshot.executionSpec.modelRetry`: `{max, baseMs, capMs}`. `max` is the number
of retries after the first attempt, from zero through eight. Base and cap are
between 1 and 30,000 milliseconds, with base no greater than cap. Missing policy
preserves the compatibility behavior of zero retries. Controller has not yet
published the delivery default of two retries; explicit fixture policy is not
evidence that existing or newly created Agents receive that default.

The main turn and permission judge share one Run counter of physical model
attempts, including failed and cancelled calls. Every admitted attempt reserves
one ordinal and consumes one slot. A persisted start that is cancelled before
Provider dispatch retains its reserved slot and a cancelled finish fact. The
judge reserves the final slot for foreground work and bounds its entire retry
chain to ten seconds or the original Run deadline, whichever is earlier. The
deadline is converted once to a monotonic cutoff; audit waits, input copying and
backoff cannot renew it.

Retry requires an explicitly retryable `ModelError` before any output starts.
HTTP 400/401, unknown errors, cleanup failures and persistence failures never
retry. Cancellation, revoked access or Provider credentials, and lost execution
ownership stop further admission. Backoff uses full jitter from zero through
`min(capMs, baseMs * 2^(retry-1))`. A valid Retry-After delta or HTTP date is
normalized once, provides a delay lower bound and is capped by the policy cap.
The original cutoff still applies; an exhausted deadline cannot dispatch the
next attempt. The original cancellable wait is joined before its owner returns.

For streaming responses, a failed attempt records whether any nonempty text,
thought, refusal or Tool-call fragment has arrived. Tool identifiers, names and
argument fragments count even while the complete Tool call is still being
assembled. Empty control chunks and usage-only chunks do not open this boundary.
`ModelError.outputStarted` preserves that fact even when no complete public
message or Tool call has been assembled. Nonempty successful content, thought
and Tool proposals also count as output.

Each attempt persists a hidden start fact before Provider admission, then one
finish after the original model task has joined. Facts record the shared ordinal,
frozen Provider/model identity, purpose, safe outcome/reason, duration, output
boundary and known usage. They contain no credentials, raw Provider errors or
Prompt text. Finish and its usage measurement commit in one PostgreSQL
transaction; an idempotent retry returns the original receipt. An empty usage
measurement `{}` means unknown consumption, not a known zero. Hidden attempt
facts are excluded from Session replay and model context; only the saved usage
projection is published. See [Session cost](session-cost.md).

Completion waits for the original body reader, both decoding/parsing pipes and
the original Provider dispatcher to finish cleanup. A DONE marker does not end
this ownership. Cancellation during cleanup prevents a late success. Independent
cleanup failures are non-retryable and retain the original operation failure,
known usage and output boundary, including when a caller's output callback fails.

The permission judge can fall back to asking the user when classification fails.
It propagates model cleanup and persistence failures; accounting failure is
retained alongside cleanup failure. The Tool loop must not continue as if that
original attempt had cleaned up successfully. A Tool proposal returned after
Run cancellation or deadline expiry is retained only as rejected, undispatched
history. It does not re-enter authorization or execute a Tool; ownership loss
still forbids further writes.

Focused coverage includes the [Run policy tests](../test/application/model-call-policy.test.ts),
[durable attempt tests](../test/application/model-attempt-events.test.ts),
[PostgreSQL receipts](../../../tests/integration/agent-acp-service/adapters/postgres/model-attempts.postgres.test.ts)
and [real HTTP/PG ACP scenarios](../../../tests/integration/agent-acp-service/e2e/acp-model-retry.postgres.test.ts).
The HTTP/PG scenarios exercise ACP v1/v2, JSON/SSE retry, replay and original
resource cleanup; they are component evidence, not Docker E2E.

Fallback, the Provider circuit breaker, Run/organization spending ledgers and
caps, Controller default publication, Console controls and final Docker business
acceptance remain pending under the
[model-call policy contract](../../../contracts/agent-controller/model-call-policy.md).
The floating-point Session cost projection is not a spending ledger. This ACP
batch does not complete #52.
