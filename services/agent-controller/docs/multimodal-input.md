# Multimodal Model Authority (F09)

Status: Controller service batch accepted on 2026-09-09. ACP input conversion is
implemented; Console configuration and deployed Gateway/ACP acceptance follow
separately. Existing human-acceptance stacks have not been rebuilt for F09.

## Contract

Model profile input, revision readback and admitted
`execution_spec.model` gain optional `supports_audio` and `supports_pdf` booleans.
Omission means false. They describe native input on the configured provider route,
not a request to install a converter or fetch an attachment URL. Known and unknown
models both retain administrator-supplied capabilities. Builtin metadata is a
Console-owned draft default, not Controller authority. Model names never cause
Controller to overwrite flags or bypass validation.

`resolve-agent-access.prompt_capabilities.audio` is optional, default false.
Image/audio availability is the union of enabled, same-organization model heads
whose Provider connections are also enabled. Defaults use the same current-head
resolution. Historical revisions, disabled profiles and foreign organizations cannot
contribute capabilities. A stale access-binding image flag is not authority.
`embedded_context` is always true after authorized access resolution because ACP
implements UTF-8 embedded text independent of model modality. It does not promise
support for every binary MIME. Existing access-binding capability columns remain
historical build metadata; they do not override the current availability query.

Session configuration option lists retain their existing safe selection shape;
they are not a second modality authority. Run admission freezes the selected
complete model revision, Provider connection binding and configuration digest.
Credential versions are resolved independently on that connection. Changing model flags changes that digest. Replaying an accepted admission
returns its original flags even after the profile changes. ACP checks those flags
for each actual completion, including attachments retained in history after a
Session model switch. Connection negotiation is a point-in-time declaration, not
permission to bypass admission or model validation later.

## Ownership And Delivery

No new tables, migration, file storage, conversion endpoint, Runtime configuration
or cross-service database access is required. Model flags live in existing
`agent_controller.model_profiles.model`, Agent spec snapshots and
`run_admissions.snapshot`. Existing RPC and automatic PostgreSQL driver spans
apply; SQL bind parameters and result bodies are not added to driver spans.
SQL text and driver diagnostics retain the limits in the telemetry policy.
Development RPC payload capture
follows [observability](observability.md), and may include credential material.

The original F09 control revision 14 / Run revision 11 added these fields.
P2 now uses control revision 20 / Run revision 13, with stable template model
identity and independent credentials; ACP consumption of P2 remains pending. Deploy the prepared ACP decoder before this Controller. The
Console BFF/form must preserve the new flags before editing such profiles through
the UI. This batch does not implement that UI or claim cross-service acceptance.

## Acceptance

1. RPC input/output and schema tests: true, false and omitted flags; reject
   invalid boolean values and unknown fields; never echo secrets.
2. Catalog/domain tests: authoritative known metadata, administrator-owned custom
   flags and configuration digests sensitive to both modalities.
3. PostgreSQL tests: enabled organizational choices, defaults following current heads,
    disabled/foreign exclusions, no stale binding override, immutable
   admission replay and post-restart readback.
4. Controller HTTP + PostgreSQL fixture: profile create/read/revise, actual
   access declaration, Run snapshot and lifecycle rebuild; preserve trace ancestry.
5. Serial service tests, race checks, format/lint and shared contract consumer
   checks. Gateway v1 HTTP/v1-v2 WS, UI, native provider byte fixtures and Jaeger
   deployment are the later F09 integration batch, not replaced by local tests.

## Verification

- Controller: all 13 Go packages passed normal and race runs with real PostgreSQL
  enabled, including the HTTP lifecycle/configuration fixture. It verifies incoming
  trace parenting through access resolution and admission, not a new Jaeger report.
- ACP consumer: 6 shared-contract tests passed against Run contract revision 11;
  its implementation was already prepared in the preceding service batch.
- Root `make fmt-check`, `make lint` and `git diff --check` passed. Standard Go
  lint reported zero issues; both Rust Clippy and TypeScript checks passed.
- Tests used one dedicated PostgreSQL instance, one service-owned test database
  and serial commands. The temporary `antnest-f09-controller-tests` container,
  volume and networks were removed. No external Provider was called, and retained
  acceptance stacks were not changed.
