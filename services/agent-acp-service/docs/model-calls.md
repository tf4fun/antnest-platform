# Model calls

Each OpenAI-compatible adapter call makes one Provider request. The ACP Run path
can retry a model and move to a capable fallback under the policy frozen in its
execution snapshot. Provider clients own credentials and revocation; attempts
retain the original Run, input and deadline. Retrying or changing candidates
never resubmits the original Prompt or creates a new Run.

An explicit Agent publication field `model_retry` maps to
`snapshot.executionSpec.modelRetry`: `{max, baseMs, capMs}`. `max` is the number
of retries after the first attempt, from zero through eight. Base and cap are
between 1 and 30,000 milliseconds, with base no greater than cap. Missing policy
preserves the compatibility behavior of zero retries. Controller has not yet
published the delivery defaults of two retries and `before_output`; explicit
fixture policy is not evidence that existing or newly created Agents receive
those defaults.

An explicit Agent `failover` maps to `snapshot.executionSpec.modelFailover`.
`before_output` exhausts the configured retries on each candidate before trying
the next eligible candidate; `never` disables that runtime switch. Omission
preserves the legacy no-failover behavior. It does not change existing
selection-time handling of a disabled default model or Session model overrides.
With explicit policy, admission also freezes the ordered `fallbackModels` plan
from the same accepted publication as the effective primary: model and Provider
identifiers, endpoint, parameters, capabilities, thinking effort and prices.
Disabled models or Providers and the effective primary are excluded from that
candidate list. Credentials are not stored in the plan. Later catalog updates
cannot replace the frozen parameters or prices of an already admitted Run.

Before dispatch, fallback selection preserves the complete input and skips
candidates that cannot accept its media, Tool definitions or Tool history,
exact thinking effort, or context size. A fallback needs explicit
`supports_tools: true` when Tool support is required; omission does not prove
support and does not change legacy primary-model behavior. Thinking uses the
existing exact Provider/model capability table and is never silently dropped.
Context compatibility uses the existing length/4 estimate and output reserve;
it is not a proven hard token budget. Improved estimation remains under #51.

Budget denial is non-retryable for foreground and permission-judge calls. A
`budget_exceeded` decision at attempt admission dispatches no model request and
writes no finish for that rejected attempt. The judge propagates this decision
instead of requesting manual Tool approval; outstanding Tool proposals remain
recorded as not executed. The Run emits one static final notice without calling
another model. Failure to persist that notice retains the original persistence
error, and cancellation or lost execution authority keeps its normal precedence.
This rejection path does not complete the budget rollout: detailed public
budget facts, soft notifications and Controller/Console publication
remain separate delivery work.

Each physical attempt now prepares its exact serialized Provider request before
persisting the start and reserving budget. Only observations matching the frozen
candidate's organization, connection, model, protocol, endpoint and current
credential revision can supply bounds. Editable context settings do not provide
a hard input bound. Media and default/enabled reasoning remain unknown unless
the observation proves their coverage; an explicitly disabled thinking request
can use its observed output bound. A configured output cap above the observation
is rejected, never silently reduced. Retry, fallback and judge prepare separately.
See the [Provider limit contract](../../../contracts/agent-controller/provider-token-limits.md).

Before send, after DNS preparation, the request rechecks current credential
authority. Its monotonic dispatch observation distinguishes a known unsent call
from an unknown result after send. A failed/cancelled call proven unsent after its
original task and cleanup join records an internal `notDispatched` finish and
zero tokens, releasing monetary and token reservations even without pricing.
It does not fabricate a Provider cost receipt. Nonzero usage/output is never
overwritten, and independent cleanup failures remain blocking. Once send is
invoked, missing usage remains unresolved. Idempotent finish replay includes the
dispatch proof and cannot release the same reservation twice.

The original finish transaction now persists a budget settlement decision with
the actual usage. It releases only resolved reservations, checks frozen Run caps
against current organization caps, and checks the original day/month buckets even
after midnight. Strictly excessive totals or denied unknown consumption stop the
Run after commit; equality can complete this response but does not grant another
call. Exact finish replay returns the original decision without another charge.
The original request, cleanup and finish receipt must all settle before this
decision can stop the Run. No retry, fallback, permission approval or Tool dispatch
follows an exceeded decision. Returned content and Tool proposals remain durable
history; proposals are individually marked unexecuted. Cleanup/persistence failures
and cancellation retain their independent outcomes.

Run admission reads the latest durable organization policy under the same
organization lock used by attempt reservations, settlements and publication.
It rejects when known UTC daily or monthly spending plus outstanding reservations
has reached that period's hard threshold, including a zero threshold. This is
an entry gate, not a reservation for the Run's first call: a zero-price primary
alone cannot prove every future fallback, judge or returned receipt is free.
An absent hard cap and a soft-only cap do not close the gate. Unbounded historical
usage or incomplete period coverage blocks a configured hard cap under `deny`;
`allow` retains that uncertainty but never waives known exhausted spending.
Cancellation takes precedence. A rejection commits `budget_exceeded` on the
original intent without publishing its Prompt or starting a model, then releases
the original Runtime pin. An unknown commit receipt retains the pin for recovery;
it is not converted to a confirmed budget rejection. Each actual attempt still
requires the separate safe-bound reservation before dispatch.

The main turn and permission judge share one Run counter of physical model
attempts, including failed and cancelled calls. Every admitted attempt reserves
one ordinal and consumes one slot. A persisted start that is cancelled before
Provider dispatch retains its reserved slot and a cancelled finish fact. The
judge reserves the final slot for foreground work and bounds its entire retry
and fallback chain to ten seconds or the original Run deadline, whichever is
earlier. Each judge candidate uses temperature zero and caps output at
`min(256, candidate.model.maxOutputTokens)` tokens. Switching candidates resets
only that candidate's retry count, never the shared ordinal, model-request
budget or deadline. The deadline is converted once to a monotonic cutoff;
audit waits, input copying and backoff cannot renew it.

Retry or fallback requires an explicitly retryable `ModelError` before any
output starts.
HTTP 400/401, unknown errors, cleanup failures and persistence failures never
retry or switch candidates. Cancellation, revoked access or current Provider
credentials, and lost execution ownership stop further admission. Backoff uses
full jitter from zero through
`min(capMs, baseMs * 2^(retry-1))`. A valid Retry-After delta or HTTP date is
normalized once, provides a delay lower bound and is capped by the policy cap.
The original cutoff still applies; an exhausted deadline cannot dispatch the
next attempt. The original cancellable wait is joined before its owner returns.

Context preparation retains its original cancellation and primary-Provider
availability checks. During execution, the most recently selected foreground
Provider is monitored through Tool work and the gap before the next foreground
call, even after its attempt handle is released. RunModelClient's
`onForegroundProvider` callback updates the RunExecutor-owned watch only for
foreground selection. A permission judge uses its own handle signal for its
original in-flight call and does not replace that watch. Thus, after A fails
and B proposes a Tool, a completed judge call on A leaves B monitored: revoking
B still stops the Tool, while revoking A does not stop that Tool. Each attempt
obtains a fresh handle with the current authorized
credential. Before injecting that credential, the handle checks the request's
organization, connection identifier and frozen base URL against its own binding.
Removing and recreating a connection cannot send a new credential to an old
Run's different endpoint. Original tasks are joined before handles are released,
and Run cleanup removes its foreground Provider listener.

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

PostgreSQL checks each start against the original Run's allowed frozen candidate
identity and each finish against that candidate's context window. The ordinary
usage projection therefore uses the selected candidate's `contextSize` and its
returned usage, including cost measured with that candidate's frozen prices.
Finish does not append a second, separate usage charge.

Completion waits for the original body reader, both decoding/parsing pipes and
the original Provider dispatcher to finish cleanup. A DONE marker does not end
this ownership. Cancellation during cleanup prevents a late success. Independent
cleanup failures are non-retryable and retain the original operation failure,
known usage and output boundary, including when a caller's output callback fails.

The permission judge can fall back to asking the user when classification fails.
It propagates revocation of its in-flight Provider, model cleanup and persistence failures;
accounting failure is retained alongside cleanup failure. The Tool loop must not continue as if that
original attempt had cleaned up successfully. A Tool proposal returned after
Run cancellation or deadline expiry is retained only as rejected, undispatched
history. It does not re-enter authorization or execute a Tool; ownership loss
still forbids further writes.

Relevant test sources include the [Run policy tests](../test/application/model-call-policy.test.ts),
[fallback policy tests](../test/application/model-fallback-policy.test.ts),
[frozen candidate tests](../test/domain/model-fallback-snapshot.test.ts),
[candidate client tests](../test/application/run-model-client.test.ts),
[durable attempt tests](../test/application/model-attempt-events.test.ts),
[PostgreSQL receipts](../../../tests/integration/agent-acp-service/adapters/postgres/model-attempts.postgres.test.ts)
[real HTTP/PG retry scenarios](../../../tests/integration/agent-acp-service/e2e/acp-model-retry.postgres.test.ts)
and [real HTTP/PG fallback scenarios](../../../tests/integration/agent-acp-service/e2e/acp-model-fallback.postgres.test.ts).
The component scenarios exercise ACP v1/v2, JSON/SSE retry and fallback,
independent Provider credentials, candidate pricing, hidden attempt receipts,
replay without new model requests and original resource cleanup. Component
checks do not substitute for the final Docker business acceptance.

## Provider circuit delivery contract

Each current organization/Provider connection has a circuit in
one ACP process. Foreground calls and permission judges across Runs share it;
separate organizations, connections and replacement clients do not. This is a
local transport-health optimization, not a distributed budget or a promise of
one global probe across ACP replicas. Restarting ACP resets local health.

The operator defaults are three consecutive retryable Provider failures
and a 30-second cooldown. `ANTNEST_ACP_PROVIDER_CIRCUIT_FAILURE_THRESHOLD` accepts
integers from 1 through 100; `ANTNEST_ACP_PROVIDER_CIRCUIT_COOLDOWN` uses existing
`ms`/`s`/`m` duration syntax from 1 ms through 60 minutes. Successful calls reset
the failure count. Counted failures are retryable HTTP 408/429/5xx or a retryable
transport/endpoint-unavailable failure without an HTTP status. Caller cancellation, authorization loss, HTTP 400/401,
non-retryable errors, persistence errors and cleanup failures are neutral health
observations. They retain their existing blocking behavior for the Run.

The policy obtains a circuit permit before consuming a physical request
slot or persisting an attempt start. An open circuit skips to the next frozen,
compatible fallback only under `before_output`; otherwise it returns typed
`model_unavailable`. Skipping creates no synthetic attempt or usage measurement.
Opening on the current failure skips remaining retries without another backoff.
The original deadline, streaming boundary and authorization still apply.

After cooldown, only one half-open probe may proceed. Its permit remains held
until the original model task, transport cleanup and attempt finish/usage receipt
have settled. A successful probe closes the circuit; a failed or neutral probe
starts another cooldown. A stale result from an older circuit generation cannot
reset health or release a newer probe. Preparing context or holding a Provider
revocation signal does not acquire a probe; circuit state never revokes access.
Replacing a removed Provider creates fresh health state without reviving old
handles or admitting an old Run to a different endpoint.

Run/organization spending ledgers and
caps, Controller default publication, Console controls and final Docker business
acceptance remain pending under the
[model-call policy contract](../../../contracts/agent-controller/model-call-policy.md).
The floating-point Session cost projection is not a spending ledger. This ACP
batch does not complete #52.
