# Standard ACP Multimodal Input

This document describes how Agent ACP Service accepts text, image, audio, PDF
and resource-link Prompt content, how it validates that content, and how it
forwards it natively to the admitted model. Delivery is tested with a
deterministic Provider fixture; it makes no claim about a real model's
recognition quality.

## Scope And Contract

The service uses standard v1/v2 Prompt content, not a private transcription endpoint:

| Input                                                                       | Consumption                                                    | Authority                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Text, UTF-8 embedded text/blob                                              | Text in the model conversation                                 | ACP built-in support             |
| Image                                                                       | Existing image input                                           | Admitted `model.supports_images` |
| Audio (`audio/wav`, `audio/x-wav`, `audio/wave`, `audio/mpeg`, `audio/mp3`) | Native OpenAI-compatible `input_audio`, WAV/MP3, text response | Admitted `model.supports_audio`  |
| Embedded `application/pdf` blob                                             | Native OpenAI-compatible `file` content                        | Admitted `model.supports_pdf`    |
| Resource link                                                               | Existing reference text; never fetch its URL in the adapter    | Existing baseline support        |

`supports_audio` and `supports_pdf` are optional booleans in the Controller's
[execution model contract](../../../contracts/agent-acp/execution-api.md);
absent means false. They describe an explicitly configured model/provider
route, not every OpenAI-compatible endpoint. They belong in the immutable
admission snapshot alongside `supports_images`. They are not additional ACP
fields or client-configurable endpoints.

Both ACP versions advertise `image`, `audio` and `embeddedContext` prompt
capabilities. These describe the service's input handling, not the currently
selected model (`src/transport/acp/capabilities.ts`). Each actual completion
still checks the admitted model, including historical content after a Session
model change. Embedded context enables the built-in text path; it does not
promise that every model consumes every binary MIME type.

Native forwarding goes only to the already admitted provider with its existing
credential, cancellation/deadline and OTLP request span. No extra upload API,
third-party conversion endpoint, external URL fetch or new credential is used.
Unconfigured conversion backends are never inferred. DOCX, archives, OCR-only
local extraction and non-WAV/MP3 audio are explicitly unsupported; conversion
adapters are not implemented.

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
   Load/fork/recovery use the same content; there is no separate attachment
   table or transcription cache.
5. Context assembly retains its existing budget guard. Serialized binary size
   contributes to the conservative estimate; this is not a precise audio/PDF
   token count. Provider context errors remain authoritative. Model context
   limits are not inflated, and attachments are not silently discarded to fit a request.
6. Model conversion checks the admitted modality flag before any Provider HTTP
   call, producing native content in original order. Unsupported model/content
   errors are non-retryable local errors, not network unavailability. Existing
   Run failure finalization releases admission and records the failure.

Attachment bodies, Base64 and credentials are not added to logs/spans or
validation error messages. User history intentionally retains submitted content.
PDF filename is a fixed `attachment.pdf`; the URI is preserved separately as
reference text, never used to read a server file or choose an upload destination.

## Cross-Service Responsibilities

- Agent ACP Service: domain validation, execution snapshot decoding, v1/v2 audio
  negotiation, native model conversion, persisted replay and failure closure.
  Unit tests cover mixed ordering, MIME/encoding/size rejection, model mismatch,
  exact outgoing native bytes and no network calls on rejected content.
- Agent Controller: administrator-owned model flags and current execution
  snapshot publication. See
  [Controller multimodal input](../../agent-controller/docs/multimodal-input.md).
  A producer flag should not be enabled before the ACP consumer is deployed.
- Admin Console/BFF: administrator capability configuration and explicit
  response projections. Known metadata is read-only, custom flags are
  independent, and immutable revisions preserve their stored values. See
  [Console multimodal models](../../admin-console/docs/multimodal-models.md).
  Deploy the BFF and forms together before editing these profiles through the UI.
- Agent UI: client input controls, native encoding and history presentation
  against negotiated support, with no arbitrary conversion URL field. See
  [Agent UI multimodal input](../../agent-ui/docs/multimodal-input.md).

The [deployment profile](../../../tests/e2e/acp-multimodal/README.md)
(`make e2e-multimodal`) covers Gateway v1 HTTP and v1/v2 WebSocket, actual
Controller configuration, a model request fixture that inspects binary bytes,
text/image/link regressions, load/fork/isolation, failed Run release and Jaeger
ancestry. Unsupported ZIP content is rejected before admission. A fixture is not
evidence of recognition quality.

No migration, additional database table or Runtime change is required. Session
model selection lists retain their existing shape; actual modality checks use
the frozen admission.

## References

- [OpenAI native file input](https://developers.openai.com/api/docs/guides/file-inputs)
  documents Chat Completions `file.file_data` and `filename`.
- [OpenAI audio input](https://developers.openai.com/api/docs/guides/audio)
  documents Chat Completions `input_audio`. Only configured compatible models
  are eligible; this is not a switch to Responses API.
