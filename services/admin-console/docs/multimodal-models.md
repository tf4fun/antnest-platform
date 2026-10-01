# Native Model Input Configuration

This document describes how Admin Console configures and projects the native
Image, Audio and PDF input capabilities of a model.

## Contract And Ownership

The existing model create/revise commands carry optional `supports_audio` and
`supports_pdf` booleans inside `model`, alongside `supports_images`. Omission means
false. Controller remains the validation and model metadata authority. BFF keeps
the raw command model for owner validation; browser response projections explicitly
allow known model fields only, including these two flags. No separate endpoint,
table, credential type, conversion service or permission exists for them.

The flags are preserved across the model catalog, profile list/current/write
revision, create/revise responses, Overview and Agent configuration projection.
Organization scope comes from the trusted Edge principal. Non-administrators
cannot read or mutate these resources. Internal fields and Provider credentials
are never projected or stored in browser retry state.

## UI Behavior

- Builtin capabilities are Console-owned default data. They prefill new drafts;
  the Model settings disclosure allows edits. Stored revisions always win over
  newer catalog defaults. Audio/PDF are never inferred from image support.
- All model drafts expose independent Image, Audio and PDF input checkboxes.
  Audio means WAV/MP3 native input, not automatic transcription. New/omitted
  flags are false; editing any profile starts from its stored revision.
  Selecting an unlisted model for an existing connection clears preset flags.
  Custom Provider creation is not exposed.
- List and revision detail show supported input formats. Historical detail uses
  its stored model, not the current catalog head, and remains read-only.
- Creation/revision preserves all flags through submission, transient retry and
  success readback. Explicitly clearing a capability sends false. Failed
  publication keeps the draft; a new form does not inherit an abandoned draft.

The Agent UI consumer is described in
[Agent UI multimodal input](../../agent-ui/docs/multimodal-input.md); protocol
behavior is in [ACP conformance](../../agent-acp-service/docs/protocol-conformance.md).

## Testing

1. BFF tests: all projection surfaces, true/false/omitted flags, command forwarding,
   owner rejection, administrator scope and stripping of nested internal fields.
2. Pure frontend tests: catalog defaults, independent flags, false defaults
   and supported-format presentation.
3. Component tests using the actual API wrapper: unlisted-model creation, revision
   preservation/clearing/retry, immutable connection/model identity, editable
   builtin and saved current metadata and no credential persistence.
4. Browser desktop/mobile checks of layout and controls with synthetic data.
   They do not verify native model recognition or a Gateway deployment.
