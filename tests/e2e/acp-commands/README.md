# ACP slash commands E2E

This scenario verifies ACP slash commands, embedded context and Session replay
on a disposable full stack. It uses a disposable Stage 3 Compose project with
one PostgreSQL instance holding separate service databases, the real Gateway,
Identity, Controller, ACP service, Runtime and Jaeger. Only the model is
deterministic. No external API key, client MCP injection or browser is needed.

## Running

```sh
npm --prefix services/agent-acp-service ci
make docker-build-stage3
make test-command-fixtures
make e2e-slash-commands
```

`make test-command-fixtures` runs the transcript and Trace validators without
Docker. `make e2e-slash-commands` reuses the bounded Stage 3 wrapper and must not
target an existing development project.

The fixture client has no Docker socket and never queries databases. All
identities, Templates, Agents and ACP Sessions are created through the Gateway.
Setup creates a Provider connection and Model, references the Model's stable
identity from a Template, uses the returned Template revision and waits for the
Agent to become executable. The command-specific Compose override ignores the
local `.env`, removes the host Temporal port and keeps dynamic IP allocation
separate from the fixed Egress and Jaeger addresses.

## Scenarios

1. Stable v1 WebSocket, stable v1 HTTP and draft v2 WebSocket clients receive an
   executable `help` catalog from the official ACP SDK. HTTP notifications may
   arrive separately from the Session setup response.
2. `/help` and `/帮助` execute through Prompt, keep a file reference, emit one
   assistant reply each and finish normally. They emit no usage or Tool calls
   and make no model fixture requests. ACP advertises `embeddedContext`, so the
   help prompt also keeps embedded UTF-8 text. Unsupported ZIP content must
   fail explicitly with `unsupported_resource_content`, without creating a Run
   or history.
3. Reconnect with load or resume replays exactly the original two user prompts
   and two replies. Resume without replay does not duplicate content. Fork
   copies the same history. Every setup returns one current catalog, never a
   saved catalog event presented as transcript.
4. Another user cannot access the Agent, and another Agent of the same user
   cannot load, fork or prompt the original Session. Rejections produce no
   catalog or content, and all three transports return exact ACP errors. An
   authenticated WebSocket upgrade or HTTP initialization does not grant Agent
   access; the foreign user's `session/new` must fail with `access_denied`.
5. After help, ordinary v1 and v2 prompts still execute a real Runtime Bash
   command and return its actual output.
6. Jaeger must contain one distinct Trace for each recorded request: six
   command Runs, two ordinary Runs and 32 setup, restore and rejection
   requests. Commands require Gateway ancestry, the current Run identity and
   committed ACP PostgreSQL writes, but no model, credential or Runtime
   operations. Runs must not call management services. Setup, restore and
   rejection Traces must contain the actual request without Run execution.
   Ordinary Traces correlate the model fixture's HTTP CLIENT IDs through
   `model.complete` to the owning Run, fresh Runtime preparation and exactly one
   real Bash invocation.

## Trace collection

WebSocket requests are observed at the official SDK stream boundary without
changing messages. Their JSON-RPC IDs and connection links distinguish repeated
prompts and resumes on one connection. HTTP uses the SDK's fetch hook to record
each POST's Gateway response Trace ID and sends no invented Trace parent; the
Gateway HTTP root and ACP HTTP and dispatch ancestry must be complete. Observers
keep method, request and Session IDs, never prompt payloads. The domain-level
resume operation can be `acp.session.resume`, while the request boundary must
carry the actual wire method and JSON-RPC ID.

All Traces require full topology, disabled payload capture and private-content
checks. Rejection diagnostics are allowed only on the matching rejected ACP
boundary and domain operation. Stable collection is bounded and requires three
equal span-ID sets taken one second apart. Timing warnings are strict failures
and make the command exit nonzero even when the business checks pass.

The transcript and Trace validators have positive and deliberately corrupted
fixtures. Missing Traces, missing persistence, duplicated replies, extra
execution and unrelated Runtime spans must fail. Only compact final counts are
kept, never Trace payloads, cookies or intermediate reports.

## Cleanup

The client uses the shared `withAgentCleanup` helper, which attempts to delete
every created Agent and reports cleanup failures without hiding an earlier
business failure. The wrapper then removes the whole project, including
synthetic records, Runtime workspaces and test networks, after success or
failure.

## Not covered

This profile verifies reconnect and history restoration, not recovery after a
killed process or browser rendering. Multimodal input and Session cost have
their own scenarios in [acp-multimodal](../acp-multimodal/README.md) and
[acp-cost](../acp-cost/README.md).
