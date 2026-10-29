# Console model-call policy (#52)

Admin contract version 58 exposes the organization model-call budget through the
Console BFF at `/api/admin/model-call-policy`, plus the optional Template model
policy members already defined by the shared
[model-call policy contract](../agent-controller/model-call-policy.md).

## Organization budget read

`GET /api/admin/model-call-policy` accepts no query or body. It returns the
browser projection `model_call_policy`: exactly `revision`, `unknown_cost`,
`run_caps`, `daily`, `monthly` — the owning Organization is carried by the
verified caller context and is never repeated in the body. Revision 0 with
`unknown_cost=allow` and empty cap objects is the default when no policy is
persisted; it is not a stored record.

## Organization budget replace

`PUT /api/admin/model-call-policy` takes a complete replacement plus two
preconditions. `expected_revision` is the CAS against the displayed revision.
`expected_principal` is exactly `[organization_id, user_id]` of the signed
account as a stale-account guard — the BFF compares it to the verified CCT and
returns `409 principal_changed` on mismatch without calling upstream. Neither
field grants authority; the signed caller context remains the sole authority.
A successful response re-validates the upstream acknowledgement (organization,
revision `expected_revision + 1`, exact caps) and projects the same five
browser fields.

All money amounts are nonnegative integer USD microdollars with the shared
safe-integer bound 9007199254740991. A soft period cap must never exceed its
hard cap on the same period; `model_retry` requires `base_ms <= cap_ms` within
the contracted bounds. Reusing an `Idempotency-Key` replays the original
request identity; a stale CAS returns `resource_version_conflict` and a changed
intent on a used request returns `request_id_conflict`.

## Template model policy

Template create and revise accept the optional `template_model_policy` members
`model_retry`, `failover` and `run_budget`; reads, revisions and listings carry
them only when stored. Omitted members stay omitted in immutable history —
absent means "platform default", never an invented value.
