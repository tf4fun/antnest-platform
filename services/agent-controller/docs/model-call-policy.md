# Model-call policy

## Organization budget management

`GET /internal/model-call-policy?organization_id=…` and
`PUT /internal/model-call-policy` manage one budget policy per organization.
Both reuse the verified `admin-console` workload and system/Organization
administrator caller context; the requested `organization_id` must match signed
`org` and PUT's `actor_principal_id` must match signed `sub`. GET returns the
flattened policy (`organization_id`, `revision`, `unknown_cost`, `run_caps`,
`daily`, `monthly`). An organization without a persisted policy reads as
revision 0, `unknown_cost=allow` and empty cap objects — a logical default that
creates no policy row, receipt or execution head.

PUT is a complete strict replacement: all eight fields are required and
non-null, including `expected_revision` (explicit 0 accepted for the default),
`unknown_cost` (`allow`/`deny`), `run_caps`, `daily` and `monthly`. Nested cap
objects keep the shared bounds: optional nonnegative safe-integer
`max_input_tokens`/`max_output_tokens`/`max_cost_usd_micros` and
`soft_cost_usd_micros`/`hard_cost_usd_micros` with soft never above hard.
Unknown, case-aliased or duplicated members are rejected.

The mutation fingerprints the full request intent `(request_id,
organization_id, actor_principal_id, expected_revision, unknown_cost, run_caps,
daily, monthly)` onto a durable `(organization_id, request_id)` receipt. After
current authentication an identical replay returns its original stored response
without touching policy, receipt or publication head — even after later
updates. Changed intent on a used request ID returns
`409 request_id_conflict` before CAS; a fresh request with a stale expected
revision returns `409 resource_version_conflict`. Revision exhaustion conflicts
rather than wrapping; the bound is 9007199254740991.

A committed replacement writes the current policy row, advances the
organization's normal execution publication head (through the same capacity
check and after-commit observer hint as catalog mutations) and stores the
receipt in one transaction, serialized with the ordinary publication/catalog
organization lock. Capacity, revision-overflow and receipt-write failures roll
back all three effects and emit no observer hint. Policy changes record no
accounting or Run history.

Once persisted, the policy is published as `organization_budget` (`revision`,
`unknown_cost`, `run_caps`, `daily`, `monthly`, without an embedded
organization) in every ordinary execution snapshot for that organization.
Absent rows emit no field, so existing publication bytes are unchanged until
the first PUT — the revision-0 GET default is semantically identical to the
legacy absent default. ACP treats the emitted budget as the current durable
organization policy per the shared contract.

Controller owns the immutable Template policy and the effective configuration
published to ACP. Control contract revision 44 adds optional `model_retry`,
`failover` and `run_budget` fields to Template create/revise/read and the frozen
Agent configuration projection. Revision 45 adds the organization budget policy
described above. The [shared policy contract](../../../contracts/agent-controller/model-call-policy.md)
defines their exact wire units and bounds.

`model_retry` requires all three members: `max` is zero through eight retries,
and `base_ms`/`cap_ms` are integers between one and 30,000 with base no greater
than cap. `failover` is `before_output` or `never`. A Run budget contains optional
cumulative `max_input_tokens`, `max_output_tokens` and `max_cost_usd_micros`
limits, each an integer from zero through 9,007,199,254,740,991. Zero is retained
as a limit on positive consumption; omission imposes no new limit. Explicit
null, unknown members, noncanonical names and malformed numbers are rejected.
Create and revise replace these policy objects; they are not per-member PATCHes.

Template history, materialized AgentSpec JSON and its digest retain the exact
configured values. Missing fields stay missing there, including on readback.
All optional values are copied when crossing immutable snapshot boundaries.
Legacy requests keep their original serialized fingerprint; a request with an
explicit policy has a different fingerprint and cannot reuse an earlier
idempotency key to change that request. Changing a Template creates a new
revision and follows the existing Agent creation/rebuild rules.

Every current execution publication explicitly fills only missing retry and
failover settings: two retries with 200 ms base and 30,000 ms cap, and
`before_output`. This includes existing and temporarily unavailable Agents.
Explicit zero retries and `never` remain opt-outs. Projection does not write
these defaults into historical Template or AgentSpec rows. Already accepted
Runs retain the policy frozen by ACP; new admissions use the new publication.
The ordinary model-request limit, deadline, authority and capacity checks remain
independent bounds.

## Deployment and publication transition

Deploy the ACP policy consumer before this Controller release. Stop and drain
all old Controller publishers before migration 0032 or starting the new binary:
the publication lock serializes delivery but cannot make two different code
versions generate the same payload for one revision.

Migration 0032 adds three nullable Template revision columns, without backfilling
immutable policy or rewriting any AgentSpec/Run. In the same migration transaction
it advances every existing organization publication revision once and creates
revision one for historical Agent organizations missing a synchronization row.
Existing applied revisions and timestamps remain unchanged. Startup publication
then sends the new effective policy through the ordinary ACP Apply/ACK path.
An old ACK does not acknowledge the new desired revision. The migration journal
makes repeated or concurrent startup idempotent. Revision exhaustion fails the
whole migration, including its DDL; it never wraps or skips an organization.

Migration 0033 adds `provider_observations` for durable saved-discovery sets
(see [provider-management.md](provider-management.md)). Published
`provider_token_limits` are trusted observed bounds bound to the current
credential version — token accounting uses them as observed capacity hints,
not as provider invoices, and they never relax the editable
`context_window`/`max_output_tokens` or Template/Run policy bounds.
Do not roll back the database journal or publication revisions. An older binary
rejects a newer migration history; use a compatible forward correction.

The Provider capability/token observation producer is delivered above:
saved discovery persists binding-checked sets and publication emits trusted
`provider_token_limits`/`supports_tools`. Organization policy management and
publication, Console controls and the final cross-service Docker acceptance
remain separate #52 deliveries. Neither producer establishes those workflows
or promises a hard token bound from an editable model setting.
