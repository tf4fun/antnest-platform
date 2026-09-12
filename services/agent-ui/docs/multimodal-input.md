# Multimodal Prompt Input (F09)

Status: Agent UI service batch verified (2026-09-09). This is the browser consumer of the
[ACP input contract](../../agent-acp-service/docs/multimodal-content.md), not a new
upload service, model catalog or conversion backend.

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
   Existing image and non-embedded text selection retains its 4 MiB limit. At
   most six attachments may be selected; overflow is an explicit error, not a
   silent truncation. Whole-request limits remain enforced by the server.
4. A failed submission keeps the draft available. Input is disabled while
   reading files, configuring the Session or submitting. No file upload occurs
   before the standard Prompt request. Rejected files create no object URLs.
5. Live messages and load/fork replay present image/audio/resource blocks as
   attachments belonging to their message ID, not raw Base64. File-backed
   browser previews remain valid while referenced by a draft, in-flight submission
   or message; the last reference disappearing and page teardown revoke object
   URLs. Replay uses inline, allowlisted image/audio data only,
   never fetching external attachment URIs. Audio replay uses a generic label
   because standard ACP audio content has no filename field.
   Reclamation must follow committed ownership: an earlier render's deferred
   cleanup cannot release a URL allocated by a later file-selection callback.
   Draft-to-submission-to-history transfers retain the preview throughout.

The service owns no durable attachment table. It never receives Provider keys
or Runtime endpoints, and sends all ACP traffic through the authenticated Edge
entry. Client MCP injection remains out of scope.

## Verification Plan

- Reusable Node tests for capability/format/size validation, exact native bytes,
  UTF-8 errors, type precedence, false/absent capabilities and unchanged text.
- Message reducer tests for mixed chunk grouping and replay, audio/PDF display,
  safe inline previews and absence of Base64 in human-readable history.
- Full service tests, production build, repository format/lint gates.
- Desktop/mobile browser checks of attachment selection, removal, errors and
  history presentation. Synthetic UI evidence is not model recognition evidence.
- Separate integration batch: actual Gateway/Controller/ACP, admitted native
  model requests, durable replay, rejected-content recovery and Jaeger ancestry.

## Final Service Evidence

| Check                                    | Result                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Pure tests                               | 31 passed, including native byte/order, format/size/capability boundaries and mixed history                                       |
| React component tests                    | 6 passed with a controlled client Port; real App selection, failure restoration and preview-reference lifecycle                   |
| Production build                         | Passed; upstream Zod annotation and existing bundle-size warnings remain non-fatal, no thresholds relaxed                         |
| Root `make -j1 fmt-check lint`           | Passed: Go zero issues, both Rust Clippy targets, ACP lint/type checks, Console and Agent UI type checks                          |
| Browser with actual frontend and ACP SDK | 1440x1000 and 360x800; exact audio/PDF bytes, image loaded, file rejection/removal, send, same-tab history and page reload passed |
| Browser resource/layout checks           | Two allocated previews per viewport, both released after authoritative replay; no page errors or horizontal overflow              |

The browser protocol peer was synthetic; no Gateway deployment, PostgreSQL,
Runtime, Provider or Jaeger acceptance is claimed here. The displayed audio is
a valid tiny WAV fixture, not evidence of transcription quality. Test browsers
were closed; the development-only preview remains available independently.

Independent read-only review found current-Agent reselection and unused preview
retention defects. Both were reproduced by failing component tests, then fixed.
Additional coverage protects a failed submission whose retry draft and local
message share one preview. The reviewer is closed. Only source tests and final
counts are kept in the repository, not browser captures or intermediate logs.

## Closeout Ownership Correction (2026-09-10)

The final candidate sweep exposed premature preview revocation: a deferred
effect combined old draft/history with the live allocation and submission refs.
In-flight ownership is now React state, and each sweep captures both candidate
URLs and their owners from the same render. The live registry only guards
exactly-once release and page teardown. No timer, retention grace or skipped
cleanup substitutes for ownership.

A controlled layout-effect file selection reproduces the stale-effect failure
before the fix. The complete Agent UI suite now passes 45 unit and 64 component
tests, including selection, pending submission, failure restoration, shared
history references, authoritative replay and unmount. Typecheck and production
build pass; existing upstream annotation/bundle advisories remain. This batch
does not claim new deployed-browser acceptance while CUA is unavailable.
