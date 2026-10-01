# Model Pricing

Controller owns submitted current prices. Console provides builtin draft defaults.
ACP owns per-execution price selection, usage and cost estimates; this is not a
billing service.

## Authority And Storage

`ModelSpec.pricing` is optional. When present it contains `currency: "USD"`,
required `input_per_million` and `output_per_million`, and optional
`cache_read_per_million` and `cache_write_per_million`.
Rates must be finite, nonnegative numbers. Explicit zero means free; missing
pricing means unknown. Required omissions and explicit nulls are invalid.
ACP decides how omitted cache rates affect its estimate.

Provider creation may include initial Models; Model create/revise accepts later
changes. These internal management endpoints enforce organization scope.
Builtin values are never silently supplied by Controller.

Current prices live in `agent_controller.model_profiles.model` JSONB.
Templates reference logical Model IDs. Model edits advance the current
configuration version and organization publication revision; no Model history
table or Controller Run snapshot is created. Catalog idempotency receipts retain
the original command response without replacing the current resource on replay.
Agent build snapshots remain immutable management history.

The publisher sends current prices to ACP alongside independent Provider
configuration. Credential rotation is a separate operation. Neither price
changes nor credential rotation rebuild Runtime. Session overrides and execution
history belong exclusively to ACP, which reads no Controller database.

## Verification

1. Domain: absent, explicit zero, negative/nonfinite rates, USD/null validation,
   JSON round trips and snapshot copy isolation.
2. Management: submitted values preserved, invalid values rejected, idempotent
   request identity and response receipts remain stable.
3. PostgreSQL: current pricing publication survives reopen; old receipts do not
   overwrite current prices; Agent/Runtime state remains unchanged.
4. Concurrent publication: one MVCC snapshot cannot mix a previous revision with
   new credentials or Model parameters.
5. Contract tests preserve the same pricing shape in management and publication.
