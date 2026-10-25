# Model retry, failover and budget policy (#52)

The shared [schema](model-call-policy.schema.json),
[manifest](model-call-policy.json) and [golden vectors](model-call-policy-fixtures.json)
define configuration shapes for owning-service batches. ACP implements retry,
fallback, circuit breaking and budget accounting/enforcement; Controller policy
publication and Console controls remain separate deliveries. These artifacts do
not add a live Controller route or establish complete #52 acceptance.

## Configuration and compatibility

Template create, revise and read, Agent configuration, and each Agent in the ACP
execution snapshot gain `model_retry`, `failover` and `run_budget` when their
owning services are implemented. Organization policy is published as the snapshot's
`organization_budget`. Controller owns configuration; ACP owns attempt execution,
usage and spending. Services do not read each other's databases.

Omitted fields on a legacy wire snapshot preserve existing behavior during rollout:
zero runtime retries, `failover=never`, no new token or cost cap, and unknown cost
allowed. This compatibility branch is not the completed delivery behavior.
Once ACP consumers support the policy, Controller must explicitly materialize and
publish the effective default for existing Agents as well as newly created ones:
two retries, 200 ms base, 30,000 ms cap, and `failover=before_output`. An explicit
zero retry count or `never` remains an operator opt-out. Existing stored Runs keep
their frozen policy; only newly admitted Runs consume a new publication. Delivery
must demonstrate this publication transition without changing immutable Template
history or requiring every operator to opt in to the original reliability fix.
Existing Run deadlines,
authorization, ownership fences and `max_model_requests` continue to apply.
Schema validation never inserts defaults, converts types, or drops unknown fields.
An absent limit is unlimited; an explicit zero forbids positive consumption.
Run input/output limits are cumulative across attempts, unlike the existing
per-response model `max_output_tokens`.

Money fields end in `_usd_micros` and contain safe, nonnegative integers. Console
converts an operator's dollar amount exactly to microdollars and rejects excess
precision or overflow. Existing USD-per-million-token price fields retain their
current units and wire shape. Their decimal values must be converted to exact
arithmetic before charging; the floating-point reporting total is not a ledger.

The planned GET/PUT `/internal/model-call-policy` uses the existing verified
workload and caller context and organization administrator authorization. GET
does not create a policy. Missing policy is revision zero with empty caps and
`unknown_cost=allow`. PUT replaces the entire policy, requires `expected_revision`
and the original idempotency request, and increments the policy revision.
It must not enter the active route/caller manifests before the handler exists.
The body actor must match the verified caller, and the requested organization
must be authorized by that context. Neither field grants authority. Reusing an
idempotency key with different policy content must conflict rather than replace
another accepted update.

## Attempt lifecycle

`model_retry.max` counts retries after the first attempt on each candidate, from
zero through eight. Every actual provider call also consumes the existing shared
Run model-request budget, including failed, cancelled and permission-judge calls.
The original Run deadline bounds the entire chain; switching models never resets it.

Retry only an explicitly retryable failure before any nonempty text, thinking or
tool-call delta has been emitted. Empty control and usage-only chunks do not open
that output boundary. Once output starts, failure ends the turn. Non-retryable
400/401 responses do not retry or fail over. Do not execute tools twice or replay
the original Prompt as a new Run.

Before another attempt, join the original request, stream reader and cancellation
work and retain independent cleanup failures. Cancellation, lost authorization,
lost ownership or a deadline stops backoff and further admission. A deadline is
not permission to detach the original task or release its accounting reservation.

Backoff uses full jitter between zero and `min(cap_ms, base_ms * 2^(retry-1))`.
`base_ms` must not exceed `cap_ms`; both are between 1 and 30,000 milliseconds.
A valid Retry-After delta or HTTP date is a lower bound on that delay, capped by
`cap_ms`. Convert a date to a duration once and wait against a monotonic clock.
Malformed or past values do not extend the wait. Never wait past the Run deadline
or sleep after cancellation. Retry-After 2 seconds therefore waits at least two
seconds when the configured cap and remaining deadline permit it.

After exhausting retries, `before_output` tries the configured fallback profiles
in order. `never` preserves the current runtime no-failover behavior; it does not
remove existing selection-time handling of a disabled default model. Capture all
candidate parameters and prices from one accepted publication at Run admission,
without storing credentials. Later attempts cannot re-read a newer model profile
to change that frozen plan; credential and authorization revocation still apply.

Each fallback must satisfy the original input, tools and thinking requirements.
Unknown tool support is insufficient; a planned explicit `supports_tools` field
supplies that fact. Existing primary-model behavior is unchanged by omission.
Thinking support uses the existing exact provider/model capability table and
must retain the selected effort, never silently drop it when falling back.
The broader Template/Profile following policy remains the scope of #46.

ACP records each actual attempt's ordinal, model and Provider identifiers,
normalized outcome/reason, latency, output boundary and usage result in the
original Run audit. Never store provider credentials, raw error bodies or prompts
in attempt metadata. Telemetry is auxiliary to these durable facts.

## Budget enforcement and recovery

The effective Run limit is the minimum of its frozen Template cap and the current
organization Run cap. Organization daily/monthly soft and hard caps are separate;
a soft threshold warns and a hard threshold denies admission or a further call.
Validate soft <= hard when both exist. JSON Schema only proves shape, so owning
services must reject invalid ordering and foreign or missing model references.

ACP checks the latest durable, monotonically published organization policy and
spending during Run admission and before every model call. All replicas share
atomic reservations, not separate in-memory counters. A call reserves a safe
upper bound against both UTC day/month buckets before it starts; known charges
plus outstanding reservations must fit each hard cap. Finalization keeps the
attempt's original period buckets even if it finishes after midnight.

Use provider usage to finalize each attempt exactly once, updating Run usage,
both organization periods and the reservation in one transaction. Convert price
components with exact decimal arithmetic, sum them and round upward to whole
microdollars once per call. Cache counters must follow the provider's documented
inclusive/exclusive accounting; ambiguous or incomplete usage is unknown, not
free. Zero prices are known zero, distinct from missing prices. Limits and totals
must never overflow or use binary floating-point equality for enforcement.

Unknown price or incomplete monetary usage follows the organization's allow/deny
policy. Allowing unknown cost cannot promise a complete monetary cap; retain an
explicit unknown accounting fact. This choice never waives an input/output token
cap: a configured hard token limit requires a safe bound before the call, and
admission must fail if that bound is unavailable. Do not substitute the current
length/4 estimate for a proven hard input bound. #51 owns improved context
estimation and compaction; this contract does not claim that prerequisite exists.

Soft thresholds use known charges plus unreleased monetary reservations, with
`>=` triggering a warning (including zero). Unknown consumption remains explicitly
unknown; a warning never reports a reservation as already consumed. Each organization
receives at most one durable warning per UTC daily bucket and one per UTC monthly
bucket. A new bucket permits a new warning; policy changes, restart, Run/Session
purge and a later drop in reserved totals do not reset an existing warning.

Only a successfully accepted, still-authorized Run can claim the warning, for its
current Session; hard admission denial and cancellation do not consume a warning.
Check at accepted admission, after reserving each physical attempt and after actual
settlement. Settlement uses the original reservation buckets. The warning claim,
static visible assistant notice and original admission/start/finish facts commit
atomically. Notices are excluded from model context and require no model call.
Exact attempt retries return the original notice receipt, without rechecking policy
or creating another message. Stable message IDs and the existing durable output
sequence govern delivery/replay; reconnect can redeliver that same stored message.

The soft threshold itself never denies an otherwise permitted Run, retry, fallback
or Tool. Hard limits, unknown-cost policy, authorization, persistence, deadlines and
actual resource cleanup retain their independent behavior. Warning facts identify
the original scope, UTC period, limit and known-plus-reserved amount as exact integer
USD microdollar strings, and indicate incomplete or unknown monetary accounting.

An unfinished or crashed call retains its reservation until accounting resolves;
ACP process death, a stopped Runtime or a quiescent Run alone does not prove zero
provider consumption. Tightening policy affects future admission and attempts,
without rewriting already admitted attempts or losing their reservations.

Settlement preserves actual consumption before stopping business work. In the
same transaction it compares updated charges plus unresolved reservations with
the minimum of frozen Run and latest organization caps. The attempt's original
day/month buckets also determine its settlement decision after a boundary passes;
later calls still reserve in their current UTC buckets. Actual totals strictly
above a cap stop execution; equality can complete the current response, while
subsequent consumption must independently pass admission. Unknown consumption
retains its reservation and follows the latest unknown-cost policy.

The immutable settlement decision commits with the usage and original finish
receipt. An exact finish replay returns that same decision without charging again
or recomputing under a newer policy; missing or malformed decisions fail closed.
Only after the original model task, cleanup and durable finish have joined does
ACP consume the decision. An exceeded budget stops retries, fallback, permission
approval and Tool dispatch. Original returned content and Tool proposals remain
history, with each unexecuted proposal rejected. Cancellation, lost authority and
independent persistence/cleanup failures retain their normal precedence.

`budget_exceeded` already exists in the [ACP error catalog](../agent-acp/errors.json)
and remains HTTP 422 / JSON-RPC -32043 for admission, non-retryable. Accepted v1
failures retain -32022/-32023. The [error details contract](../agent-acp/errors.md#safe-messages-data-and-fallback)
defines the original `{scope, limit, used}` fact; ACP stores it with admission
rejection or terminal outcome, exposes it in audit and validated public errors,
and writes one static final notice through the existing v1/v2 output stream.
ACP soft notices use the durable warning rules above. Controller policy
publication and Console configuration remain separate delivery work. The cross-service Docker acceptance below is
still required before closing #52.

A per-Provider-connection circuit breaker is also required by #52. Its bounded
failure threshold, cooldown and half-open probe ownership belong to the ACP batch.
ACP documents its per-process defaults of three failures and a 30-second cooldown,
operator overrides and original-task ownership in [model calls](../../services/agent-acp-service/docs/model-calls.md#provider-circuit-delivery-contract).
This local health state does not establish one global probe across replicas.
It must not replace the shared spending ledger, bypass capability checks, replay
output or reset a Run deadline. Unknown outcomes and shutdown retain original work.

## Delivery and evidence

Implement ACP parsing/enforcement with absent-field compatibility before Controller
starts publishing these fields, then Controller policy/publication and Console
controls in separate service batches. Each batch includes its owned tests and
documentation. Only the final integration batch can establish the complete workflow.

Required evidence remains: fake-clock Retry-After and bounded retries; capable
fallback ordering; no retry after output or on 400/401; cancellation/cleanup joins;
atomic ledger and concurrent cross-replica caps; unknown-cost policy; Template and
snapshot round trips; circuit-breaker cooldown; and real Docker 429/503 fallback,
attempt audit and a tiny cost cap ending with `budget_exceeded`. Shape tests and
these vectors do not substitute for any of those business checks.
