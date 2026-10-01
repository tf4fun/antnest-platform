# Multimodal Prompt Input

This document describes how Agent UI selects, validates, submits and replays
image, audio, PDF and text attachments. Agent UI is the browser consumer of the
[ACP input contract](../../agent-acp-service/docs/multimodal-content.md); it is
not an upload service, model catalog or conversion backend.

## Ownership And Flow

1. Each ACP connection retains its own negotiated prompt capabilities. The file
   picker derives its accepted formats from that connection, not from provider
   names or an old Agent's state. Text files remain available without optional
   capabilities; image/audio/PDF require image/audio/embeddedContext respectively.
   Embedded context is not a promise that the selected model accepts PDFs. The
   server checks the actual admitted model, including after a model switch.
2. Selection validates file kind, capability and size before adding a draft.
   Submission repeats these checks. WAV/MP3 become standard audio blocks; PDFs
   become embedded PDF resources; images remain image blocks. UTF-8 documents
   use embedded text when negotiated, otherwise the existing text prompt path.
   Unknown binary formats are rejected rather than silently encoded as text.
3. Native audio/PDF and embedded text are at most 1 MiB each, matching the server.
   Image and non-embedded text selection has a 4 MiB limit. At most six
   attachments may be selected; overflow is an explicit error, not a silent
   truncation. Whole-request limits remain enforced by the server.
4. A failed submission keeps the draft available. Input is disabled while
   reading files, configuring the Session or submitting. No file upload occurs
   before the standard Prompt request. Rejected files create no object URLs.
   ACP's `-32022` failure with `data.code=model_unsupported_content` has explicit
   model-capability feedback: use a compatible model or start a conversation
   without the unsupported attachment. The UI retains the draft and preview,
   never retries automatically, and does not display remote error details.
5. Live messages and load/fork replay present image/audio/resource blocks as
   attachments belonging to their message ID, not raw Base64. File-backed
   browser previews remain valid while referenced by a draft, in-flight submission
   or message; the last reference disappearing and page teardown revoke object
   URLs. Replay uses inline, allowlisted image/audio data only,
   never fetching external attachment URIs. Audio replay uses a generic label
   because standard ACP audio content has no filename field.

The service owns no durable attachment table. It never receives Provider keys
or Runtime endpoints, and sends all ACP traffic through the authenticated Edge
entry. Client MCP injection is out of scope.

## Preview Ownership

Object URL reclamation follows committed ownership. In-flight ownership is
React state, and each cleanup sweep captures both candidate URLs and their
owners from the same render, so an earlier render's deferred cleanup cannot
release a URL allocated by a later file-selection callback. Draft to submission
to history transfers retain the preview throughout. The live registry only
guards exactly-once release and page teardown. No timer, retention grace or
skipped cleanup substitutes for ownership.

## Testing

- Node tests for capability/format/size validation, exact native bytes,
  UTF-8 errors, type precedence, false/absent capabilities and unchanged text.
- Message reducer tests for mixed chunk grouping and replay, audio/PDF display,
  safe inline previews and absence of Base64 in human-readable history.
- Component tests for selection, pending submission, failure restoration,
  shared history references (including a failed submission whose retry draft
  and local message share one preview), current-Agent reselection,
  authoritative replay and unmount. A controlled layout-effect file selection
  reproduces the stale-effect cleanup case.
- Browser checks at desktop and mobile widths with the actual frontend and ACP
  SDK against a synthetic protocol peer: exact audio/PDF bytes, image loading,
  file rejection/removal, send, same-tab history, page reload, and release of
  allocated previews after authoritative replay.
- `make e2e-multimodal` runs the Docker stack with real Gateway, Controller and
  ACP, covering explicit unsupported-model feedback, retained draft/preview and
  no Provider request for rejected audio.

The audio fixture is a tiny valid WAV file; these tests do not measure
transcription quality.
