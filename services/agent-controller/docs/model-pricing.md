# Model Pricing (F10)

Status: original F10 batch verified (2026-09-09). Catalogue ownership changed
on 2026-09-11; the historical evidence below is not acceptance of that change.
Controller persists submitted prices; builtin defaults now belong to Console. ACP consumes the optional
snapshot. Console editing, Agent UI display and deployed integration are also
complete, with separate F10 evidence in
[ACP conformance](../../agent-acp-service/docs/protocol-conformance.md). This is
not a billing service or a replacement for final platform acceptance.

## Authority And Storage

`ModelSpec.pricing` is optional. When present it contains `currency: "USD"`,
required `input_per_million` and `output_per_million`, and optional
`cache_read_per_million` and `cache_write_per_million`. All supplied rates must
be finite nonnegative numbers. Missing required rates are invalid; explicit zero
means free. Explicit JSON nulls are rejected, not treated as omission. Missing
pricing means unknown, not zero. Cache rates omitted from
the snapshot fall back to the ordinary input rate in ACP estimation.

Provider connection creation accepts explicitly supplied initial model prices;
Model Profile create/revise operations accept subsequent parameter changes.
They remain trusted internal endpoints, with organization scope checked in the
service and external administrator authorization owned by Gateway. ACP Session
configuration accepts a model profile identity, never client-supplied prices.

At publication, submitted administrator pricing is the complete configuration.
Missing pricing remains unknown even for familiar provider/model names; Controller
has no builtin directory or price fallback. Console prefills known defaults and
submits them explicitly when selected. The submitted value is stored in `agent_controller.model_profiles.model`
JSONB. Templates retain model identity. Agent build snapshots keep the build-time
revision for audit only. Default and explicit Session model selections resolve the
enabled organization's current model revision at Run admission. The resulting `run_admissions.snapshot` retains the complete
model and prices. No new price table, mutable cost total or cross-service DB read
is introduced.

Changing prices creates a new Model Profile revision through the existing
model-only publication flow. Credential rotation is a separate connection command. It does not rebuild Runtime, mutate an old
Agent build snapshot or reprice history. Both an explicit profile selection and
an inherited Agent default take the new head on the next admission.
Replay/recovery uses saved snapshots. Request identity fingerprints the submitted
configuration without applying a builtin catalogue. Console repricing therefore
cannot change a completed request's identity.

## Default Data Ownership

Builtin metadata, including optional estimated prices, lives in Admin Console.
See [Console model pricing](../../admin-console/docs/model-pricing.md) for
the release snapshot and sources. Controller validates values and maintains
current organization records and immutable admission snapshots. It neither
imports Console code nor reads another service's database.

## Verification

1. Domain: missing/zero/negative/nonfinite rates, USD validation, deep snapshot
   isolation and JSON round trips.
2. Configuration: explicit values preserved for every model name, omitted prices
   remain unknown, invalid known-model input rejected, immutable retry identity.
3. HTTP/shared contracts: publication and revision prices, invalid input,
   rejection of price injection through Session configuration, optional omission.
4. PostgreSQL: price revision isolation, inherited versus selected model, frozen
   admission/reopen/replay, with no new storage structures.
5. ACP consumer: shared Run contract validates and parses the producer price
   shape. Console/UI/deployed cross-service verification follows separately.

Final service evidence (2026-09-09): full Controller `go test -p=1 -race` passed
13 packages, 350 top-level tests and 244 subtests, with zero skipped tests or race
warnings. This includes real PostgreSQL and HTTP component tests in an isolated
database on the shared development PostgreSQL instance. Shared control contract
revision 15 and Run contract revision 12 agree on the price shape. ACP's eight
consumer contract tests cover acceptance and rejection of the actual schema.
Root `make -j1 fmt-check lint` passes; no thresholds or exclusions were changed.
Readonly review findings on request identity, pointer isolation and explicit
null JSON handling have regression tests. No external Provider billing,
Console/UI or deployed Jaeger acceptance is claimed by this batch.
