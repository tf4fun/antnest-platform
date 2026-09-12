# Native Model Input Configuration (F09)

Status: original F09 batch verified (2026-09-09). On 2026-09-11 builtin defaults
moved to Console and became editable; historical metrics below predate that change. Controller, ACP, Agent UI
and protocol deployment batches are complete; their separate evidence is in
[ACP conformance](../../agent-acp-service/docs/protocol-conformance.md). Full C4
interactive browser acceptance remains open.

## Contract And Ownership

The existing model create/revise commands carry optional `supports_audio` and
`supports_pdf` booleans inside `model`, alongside `supports_images`. Omission means
false. Controller remains the validation and model metadata authority. BFF keeps
the raw command model for owner validation; browser response projections explicitly
allow known model fields only, including these two flags. No new endpoint, table,
credential type, conversion service or permission is introduced.

Preserve the flags across the model catalog, profile list/current/immutable
revision, create/revise responses, Overview and Agent configuration projection.
Organization scope comes from the trusted Edge principal. Non-administrators
cannot read or mutate these resources. Internal fields and Provider credentials
must not be projected or stored in browser retry state.

## UI Behavior

- Builtin capabilities are Console-owned default data. They prefill new drafts;
  the Model settings disclosure allows edits. Stored revisions always win over
  newer catalogue defaults. Audio/PDF are never inferred from image support.
- All model drafts expose independent Image, Audio and PDF input checkboxes. Audio in
  F09 is WAV/MP3 native input, not automatic transcription. New/omitted flags are
  false; editing any profile starts from its stored revision. Selecting an
  unlisted model for an existing connection clears preset flags. Custom Provider
  creation is not exposed in the current DeepSeek-only batch.
- List and revision detail show supported input formats. Historical detail uses
  its stored model, not the current catalog head, and remains read-only.
- Creation/revision preserves all flags through submission, transient retry and
  success readback. Explicitly clearing a capability must send false. Failed
  publication keeps the draft; a new form does not inherit an abandoned draft.

## Acceptance

1. BFF tests: all projection surfaces, true/false/omitted flags, command forwarding,
   owner rejection, administrator scope and stripping of nested internal fields.
2. Pure frontend tests: catalogue defaults, independent flags, false defaults
   and supported-format presentation.
3. Component tests using the actual API wrapper: unlisted-model creation, revision
   preservation/clearing/retry, immutable connection/model identity, editable builtin and read-only historical
   metadata and no credential persistence.
4. Serial Go tests/race, full Console frontend tests/build and root format/lint
   gates. Browser desktop/mobile inspection checks layout and controls with
   synthetic data; it is not native model recognition or Gateway deployment proof.
5. Follow-up: Agent UI input controls, then actual Controller/BFF/Gateway/ACP and
   Jaeger integration. Do not treat this Console slice as F09 completion.

## Verification

| Check                                                      | Final result                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Console frontend suite                                     | 227 passed: 82 pure tests and 145 component tests across 13 component files                                                       |
| `go test -race -p=1 ./services/admin-console/... -count=1` | All five tested packages passed                                                                                                   |
| Console production build                                   | TypeScript and Vite passed                                                                                                        |
| Root `make -j1 fmt-check lint`                             | Passed; five Go service lint runs report zero issues, both Rust Clippy gates and frontend gates passed                            |
| Browser inspection                                         | 1440x1000 and 360x800: styled dialog, independent controls, publication, immutable history, no horizontal overflow or page errors |

Browser inspection used the real Console frontend with an in-memory HTTP fixture,
not a deployed BFF or Provider. The Go suite independently exercised the actual
BFF with controlled upstreams. The first preview lacked Tailwind because its
working directory was incorrect; that result was discarded. The corrected run
also asserts dialog styles and dimensions. Test browsers are closed; only the
synthetic model-configuration preview is intentionally retained for inspection.
No external Provider, Docker deployment or new Jaeger acceptance was run in this
batch. Browser screenshots and temporary scripts are not repository evidence.
