# ACP Command Deployment Acceptance

Current revalidation: 2026-09-17. All three transport profiles and 40 independent
request trace topology/privacy checks passed. Strict Trace failed on recorded
timing warnings; the deployment command remains nonzero. See the
[current report](../../docs/slash-command-revalidation.md).

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
sessions are created through Gateway. Setup creates a Provider connection and
Model, references its stable identity from a Template, uses the returned
Template revision and waits for executable Agent readiness. The command-only
Compose override ignores local `.env`, removes the host Temporal port and
separates dynamic IP allocation from fixed Egress/Jaeger addresses.
The wrapper removes the entire owned
project, including synthetic records, Runtime workspaces and test networks,
after success or failure.

## Scenarios

1. Stable v1 WebSocket, stable v1 HTTP and draft v2 WebSocket receive an
   executable `help` catalog from the official ACP SDK. HTTP notifications may
   arrive separately from the Session setup response.
2. `/help` and `/帮助` execute through Prompt, retain a file reference, emit
   one assistant reply each and finish normally. They emit neither usage nor
   Tool calls and cause zero model fixture requests.
   ACP advertises `embeddedContext`: the help prompt also retains
   embedded UTF-8 text. Unsupported ZIP content must still fail explicitly with
   `unsupported_resource_content`, without creating a Run or history.
3. Reconnect and load/resume replay exactly the original two user prompts and
   two replies. Resume without replay does not duplicate content. Fork copies
   the same history. Every setup returns one current catalog, not a saved
   catalog event masquerading as transcript.
4. Another user cannot access the Agent; another Agent of the same user cannot
   load, fork or prompt the original Session. Rejections produce no catalog or
   content. All three transports must return exact ACP errors. An authenticated
   WebSocket upgrade or HTTP initialization does not grant Agent access; the
   foreign user's `session/new` must fail with `access_denied`.
5. Following help, ordinary v1/v2 prompts still execute a real Runtime Bash
   command and return its actual output. Reuse the tested ACP closeout model.
6. Jaeger must contain one distinct trace for each of the 40 recorded requests:
   six command Runs, two ordinary Runs, and 32 setup/restore/rejection requests.
   Commands require Gateway ancestry, current Run identity and committed ACP
   PostgreSQL writes, but zero model, credential or Runtime operations. Runs
   must not call management services. Setup/restore/rejection traces must contain
   the actual request without Run execution. Ordinary traces correlate the
   model fixture's HTTP CLIENT IDs through `model.complete` to the owning Run,
   fresh Runtime preparation and exactly one real Bash invocation.

WebSocket requests are observed at the official SDK stream boundary without
changing messages. Their actual JSON-RPC IDs and connection links distinguish
repeated prompts/resumes on the same connection. HTTP uses the official SDK's
fetch hook to record each POST's Gateway response Trace ID. It sends no invented
Trace parent; the Gateway HTTP root and ACP HTTP/dispatch ancestry must be
complete. The observers retain method/request/Session IDs, not prompt payloads.
The domain-level resume operation can still be `acp.session.resume`, while the
request boundary must carry the actual wire method and JSON-RPC ID.

All traces require full topology, disabled payload capture and private-content
checks. Rejection diagnostics are permitted only on the matching rejected ACP
boundary and domain operation. Stable collection is bounded and requires three
equal span-ID sets one second apart. Timing warnings remain strict failures and
make the deployment command return nonzero even when business checks pass.

The pure transcript and trace validators have positive and deliberately
corrupted fixtures. Missing traces, missing persistence, duplicated replies,
extra execution and unrelated Runtime spans must fail acceptance. Keep only
compact final counts, never trace payloads, cookies or intermediate reports.

This profile verifies reconnect/history restoration, not killed-process
recovery or browser rendering. Those retain their existing separate evidence.
F07 remains deferred until the official SDK supports it. These embedded-context
checks do not replace the separate multimodal or cost acceptance suites.
