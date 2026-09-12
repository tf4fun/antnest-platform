# ACP Command Deployment Acceptance

F08 integration uses a disposable Stage 3 Compose project, one PostgreSQL
instance with separate service databases, real Gateway/Identity/Controller/ACP/
Runtime and Jaeger. Only the model is deterministic. No external API key,
client MCP injection, new business command or browser-specific UI is required.

Build the current service images serially, then run:

```sh
make e2e-slash-commands
```

The entry point reuses the existing bounded Stage 3 wrapper and cleanup. It
must not use a retained development project. The fixture client has no Docker
socket and never queries databases. All identities, templates, Agents and ACP
sessions are created through Gateway. The wrapper removes the entire owned
project, including synthetic records, Runtime workspaces and test networks,
after success or failure.

## Scenarios

1. Stable v1 WebSocket, stable v1 HTTP and draft v2 WebSocket receive an
   executable `help` catalog from the official ACP SDK. HTTP notifications may
   arrive separately from the Session setup response.
2. `/help` and `/帮助` execute through Prompt, retain a file reference, emit
   one assistant reply each and finish normally. They emit neither usage nor
   Tool calls and cause zero model fixture requests.
   F09 Controller advertises `embeddedContext`: the help prompt also retains
   embedded UTF-8 text. Unsupported ZIP content must still fail explicitly with
   `unsupported_resource_content`, without creating a Run or history.
3. Reconnect and load/resume replay exactly the original two user prompts and
   two replies. Resume without replay does not duplicate content. Fork copies
   the same history. Every setup returns one current catalog, not a saved
   catalog event masquerading as transcript.
4. Another user cannot access the Agent; another Agent of the same user cannot
   load, fork or prompt the original Session. Rejections produce no catalog or
   content. Use precise permission errors, not any exception as success.
5. Following help, ordinary v1/v2 prompts still execute a real Runtime Bash
   command and return its actual output. Reuse the tested ACP closeout model.
6. Jaeger must contain Gateway ancestors, durable ACP writes and Controller
   admission/finish for command Runs, but no model, credential or Runtime
   operations. Separate restore/rejection traces must contain the requested
   operations without execution. Positive ordinary traces must correlate the
   model fixture requests with real Runtime child spans.
   v1 `session/load` and v2 `session/resume` share the application-level
   `acp.session.resume` span; wire method names are not separate domain spans.

The pure transcript and trace validators have positive and deliberately
corrupted fixtures. Missing traces, missing persistence, duplicated replies,
extra execution and unrelated Runtime spans must fail acceptance. Keep only
compact final counts, never trace payloads, cookies or intermediate reports.

This profile verifies reconnect/history restoration, not killed-process
recovery or browser rendering. Those retain their existing separate evidence.
F07 remains deferred until the official SDK supports it; F09/F10 are separate
service batches.
