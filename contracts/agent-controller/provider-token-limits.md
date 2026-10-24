# Provider token limits for model budgets (#52 / necessary #51 subset)

The optional, read-only `provider_token_limits` field on an execution model uses
the [canonical schema](provider-token-limits.schema.json). It describes observed
Provider declarations, separately from operator-editable model parameters.
Schema acceptance alone does not establish producer or consumer delivery.

Controller owns these observations. Only a successful discovery against a saved
Provider connection may replace them; draft discovery does not persist authority.
The observation binds organization, connection, Provider key, request protocol,
canonical base URL, exact API model ID and the published string credential revision.
The storage update must compare the original connection and credential binding so
a late response cannot replace observations for a newer route or credential.
Successful replacement advances `source_revision` and removes models omitted from
the new complete result. Route/identity/credential changes invalidate observations
before reuse; neither ordinary model editing nor execution reads trigger discovery.
Controller publishes matching observations with its normal execution revision.

`context_length` and `top_provider.max_completion_tokens` from `/models` supply
only the dimensions actually present and valid. Missing, malformed or zero values
remain unknown. No observation is emitted without a known dimension. Console
built-in drafts and user-supplied `context_window`/`max_output_tokens` cannot fill
these independent values. The schema permits future coverage declarations, but
the present discovery response does not by itself prove media or reasoning
coverage; Controller must omit those flags unless its source proves them.
No secret or authentication header belongs in an observation.

ACP freezes the observation with each Run candidate, including fallbacks, without
changing its frozen parameters or prices. Preparation verifies all binding fields
against the candidate and the current authorized Provider connection. A mismatch
makes the dimensions unknown; it does not rewrite the original observation or
take a smaller value from an editable model profile. Endpoints must be valid,
credential-free HTTP(S) URLs and compare in the same canonical form as routing.

A pure request preparation step produces the serialized request and its token
reservation together, before the durable attempt start. The later dispatch sends
that same serialized body. The observed context capacity is a conservative text
input bound covering messages, Tool definitions and history; never subtract the
requested output to invent a tighter input bound. Media input remains unknown
without explicit coverage. A frozen `max_tokens` above an observed output limit
is rejected before dispatch; preparation never silently reduces it. Output is
known only when reasoning is explicitly disabled in the actual request or the
observation covers all output including reasoning. Missing thinking settings
do not prove that the Provider's default disables reasoning. Preparation
does not acquire network resources. Each retry/fallback and judge prepares its
own actual request, retaining the original Run deadline and shared attempt count.

Current credentials and revocation still apply. If credentials change after a
known reservation was prepared, dispatch must reject before sending under that
obsolete binding. Check the revision and read the current secret at the final
send boundary, after asynchronous endpoint/DNS preparation. Rejected admission
and failed starts release the prepared handle; already dispatched work is joined
before releasing it. A prepared request is single-use and cannot send after release.

The prepared call exposes a monotonic internal dispatch observation. It changes
from `not_dispatched` to `possibly_dispatched` immediately before invoking send.
Missing observations and legacy calls after delegation remain unknown. Only after
the original task and cleanup join may a failed/cancelled attempt with no response,
output, status or usage retain a `notDispatched: true` finish proof and zero token
measurement. The ledger then releases its reservation with zero cost even without
pricing; this is not a Provider-reported cost. Independent cleanup failures still
fail the Run. Once send has been invoked, cancellation, errors and resource loss
never prove zero consumption. Finish replay includes the proof in its identity.

Unknown monetary bounds follow `unknown_cost`; an unknown dimension never waives
a configured hard token cap. These declarations and configured prices define
internal pre-call accounting, not a guarantee about an external Provider invoice.
Retain actual reported excess and stop subsequent business work rather than
discarding consumption or investigating external SDK behavior. The full #51
estimator, compaction and long-history behavior remain separate work.

Pending acceptance includes Controller's durable discovery/CAS and publication,
ACP binding and exact-body reservation, concurrent spending checks, unknown media
and reasoning policy, credential changes while preparation is held, and the final
Docker fallback/budget workflow. A schema-only check cannot satisfy those items.
