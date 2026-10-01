# Multimodal Model Configuration

Controller persists administrator-submitted Model capabilities. ACP owns protocol
capability declarations, Session selection, attachment validation and input conversion.

## Authority And Storage

Current Model parameters include `supports_images`, `supports_audio` and
`supports_pdf`. Omitted optional flags mean false. These flags describe native
input support on the configured Provider route; they do not install converters
or permit fetching attachment URLs.

Builtin defaults live in Console. Controller neither infers capabilities from
model names nor maintains another capability copy on Agent access bindings.
Current values live in `agent_controller.model_profiles.model`; immutable
Agent build snapshots retain their original values for management audit.

The organization publication contains the full current Model directory with
independent Model and Provider enabled flags. ACP combines their availability
when selecting a Model. Foreign-organization entries must never enter the snapshot.
Disabled entries retain descriptive metadata; they are not selectable.
Capability updates advance the organization configuration revision without
rebuilding Runtime or rewriting historical build snapshots.

No Controller Session configuration, Run admission, access-subject lookup or
per-Run snapshot is involved. Runtime content discovery remains a separate
execution concern. See [publication](execution-publication.md).

## Verification

- Domain and HTTP schema tests cover true, false, omitted and invalid values.
- PostgreSQL publication tests cover organization isolation, current parameters,
  disabled metadata, revisions and persistence after reopening the repository.
- Model, capability and pricing changes leave Agent/Runtime build state unchanged.
- ACP owns negotiation and per-completion validation, including historical
  attachments after Session model changes.

These service tests do not cover Gateway/Console consumers or Docker
deployment; `make e2e-multimodal` exercises the deployed flow.
