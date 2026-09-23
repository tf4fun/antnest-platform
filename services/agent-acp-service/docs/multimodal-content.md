# Standard ACP Multimodal Input (F09)

Status: ACP, Controller, Console/BFF and Agent UI service batches verified;
Gateway v1 HTTP and v1/v2 WebSocket deployment acceptance passed on 2026-09-09.
Native delivery is verified with a deterministic Provider fixture, not a claim
about a real model's recognition quality.

## Scope And Contract

Use standard v1/v2 Prompt content, not a private transcription endpoint:

| Input                                                                       | Consumption                                                    | Authority                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Text, UTF-8 embedded text/blob                                              | Text in the model conversation                                 | ACP built-in support             |
| Image                                                                       | Existing image input                                           | Admitted `model.supports_images` |
| Audio (`audio/wav`, `audio/x-wav`, `audio/wave`, `audio/mpeg`, `audio/mp3`) | Native OpenAI-compatible `input_audio`, WAV/MP3, text response | Admitted `model.supports_audio`  |
| Embedded `application/pdf` blob                                             | Native OpenAI-compatible `file` content                        | Admitted `model.supports_pdf`    |
| Resource link                                                               | Existing reference text; never fetch its URL in the adapter    | Existing baseline support        |

`supports_audio` and `supports_pdf` are optional booleans in the Controller's
execution model contract; absent means false. They describe an explicitly
configured model/provider route, not every OpenAI-compatible endpoint. They
belong in the immutable admission snapshot alongside `supports_images`.
They are not additional ACP fields or client-configurable endpoints.

`resolve-agent-access.prompt_capabilities.audio` is an optional boolean with
the same absent=false rule. It declares connection-level availability across
authorized model choices. Each actual completion still checks the admitted
model, including historical content after a Session model change.
`embedded_context` must be declared by Controller for the built-in text path;
it does not promise that every model consumes every binary MIME.

Native forwarding goes only to the already admitted provider with its existing
credential, cancellation/deadline and OTLP request span. No extra upload API,
third-party conversion endpoint, external URL fetch or new credential is used.
Unconfigured conversion backends are never inferred. DOCX, archives, OCR-only
local extraction and non-WAV/MP3 audio remain explicitly unsupported in this
first native-input batch; conversion adapters are subsequent F09 work if needed.

## Data Flow And Limits

1. The official SDK parses standard content and the transport checks negotiated
   capabilities. Session ownership is checked before content diagnostics.
2. Before creating a Run intent, normalize textual blobs to UTF-8, validate
   binary Base64/MIME and reject ambiguous text+blob resources. Binary attachments
   remain binary content, with their URI and outer annotations retained.
3. Each embedded resource/audio payload is bounded to 1 MiB decoded. Check the
   encoded length before decoding, then verify the decoded byte count.
   Existing whole-request HTTP/WS limits also apply; this is not
   an increase in the configured upload limit. PDF signature and audio envelope
   checks are not a complete file decoder or malware scanner.
4. Persist normalized content in the existing user message and Run intent.
   Load/fork/recovery use the same content; no separate attachment table or
   duplicated transcription cache is introduced.
5. Context assembly retains its existing budget guard. Serialized binary size
   contributes to the conservative estimate; this is not a precise audio/PDF
   token count. Provider context errors remain authoritative. Do not inflate
   model context limits or silently discard attachments to fit a request.
6. Model conversion checks the admitted modality flag before any Provider HTTP
   call, producing native content in original order. Unsupported model/content
   errors are non-retryable local errors, not network unavailability. Existing
   Run failure finalization releases admission and records the failure.

Attachment bodies, Base64 and credentials must not be added to logs/spans or
validation error messages. User history intentionally retains submitted content.
PDF filename is a fixed `attachment.pdf`; the URI is preserved separately as
reference text, never used to read a server file or choose an upload destination.

## Delivery And Acceptance

1. ACP service: domain validation, execution snapshot decoder, v1/v2 audio
   negotiation, native model conversion, persisted replay and failure closure.
   Unit tests cover mixed ordering, MIME/encoding/size rejection, model mismatch,
   exact outgoing native bytes and no network calls on rejected content.
2. Controller: admin-owned model flags, current execution snapshot publication, real
   `embedded_context` and authorized-model audio capability declarations.
   Service batch verified; see [Controller authority and evidence](../../agent-controller/docs/multimodal-input.md).
   Do not enable a producer flag before the ACP consumer is deployed.
3. Console/BFF: administrator capability configuration and explicit response
   projections verified; known metadata is read-only, custom flags are independent,
   and immutable revisions preserve their stored values. See
   [Console contract and verification](../../admin-console/docs/multimodal-models.md).
4. Agent UI: client input controls, native encoding and history presentation
   verified against negotiated support. No arbitrary conversion URL field.
   See [browser consumer evidence](../../agent-ui/docs/multimodal-input.md#final-service-evidence).
5. Integration (passed): Gateway v1 HTTP, v1/v2 WS, actual Controller configuration,
   model request fixture inspecting binary bytes, text/images/links regressions,
   load/fork/isolation/failed Run release and Jaeger ancestry. Real Provider
   acceptance is separately reported; a fixture is not evidence of recognition
   quality. F08 now accepts embedded text but still rejects unsupported ZIP
   content before admission. See the [reusable deployment profile](../../../tests/e2e/acp-multimodal/README.md).

Service batch results are recorded once in [protocol conformance](protocol-conformance.md#multimodal-input-f09-acp-service-batch-2026-09-09).
No migration, additional database table, Runtime change or external Provider
call was required in these service batches. The disposable deployment verified
Controller's embedded context and model-scoped audio declarations. Retained
development instances were not replaced. Console BFF/forms preserve native flags;
deploy them together before those profiles are edited through the UI.
Session model selection lists
retain their existing shape; actual modality checks use the frozen admission.

## References

- Local Goose `crates/goose/src/acp/server.rs::convert_acp_prompt_to_message`
  skips Audio and blob resources. Its separate dictation path is a design
  reference, not proof of a complete standard ACP input path.
- [OpenAI native file input](https://developers.openai.com/api/docs/guides/file-inputs)
  documents Chat Completions `file.file_data` and `filename`.
- [OpenAI audio input](https://developers.openai.com/api/docs/guides/audio)
  documents Chat Completions `input_audio`. Only configured compatible models
  are eligible; this is not a switch to Responses API.
