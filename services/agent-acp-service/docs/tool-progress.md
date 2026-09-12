# Tool Progress Consumption (F02)

Scope: Agent ACP Service only. Runtime owns progress production; this service
owns association, bounded presentation, durable ordering and ACP delivery.
No new table, public endpoint, private ACP field or client MCP permission.

## Contract And Flow

1. The official MCP client requests standard progress using its per-request
   `onprogress` option. The SDK owns tokens and notification correlation. The
   Tool port exposes only `{ progress, total?, message? }`, not MCP envelopes.
2. TurnRunner binds the callback to the existing normalized Tool call ID.
   Progress is diagnostic preview, never proof of successful execution.
3. `ToolProgress` accumulates bounded text snapshots. The first update is
   immediate; subsequent updates coalesce at 100 ms. There is at most one
   persistence operation in flight and one bounded pending snapshot, not a
   promise per packet. A Tool produces at most 32 preview events, each at most
   16 KiB of UTF-8 text including an explicit truncation notice. Exceeding either
   budget ends previews, not execution. Silent tools produce no preview.
4. Messages are shown verbatim as text, separated by newlines. Numeric-only
   progress is labelled with its actual values, without inventing percentages
   or interpreting arbitrary units as bytes. Invalid or decreasing progress
   is ignored. Final Tool content replaces the preview; it is not appended to it.
5. Before publishing, append an `in_progress` Tool update to `session_messages`
   under the same Session/Run lock used by start/finish. Require an active Tool
   attempt. Do not modify attempt state or effect classification on progress.
6. Completion, failure and cancellation close the callback and flush accepted
   previews before the terminal Tool event. Late callbacks are ignored.
   Ownership loss or persistence failure aborts the call; persistence failure
   follows existing Run recovery, never automatic Tool retry or fake success.
7. Both ACP versions use standard `tool_call_update` with the same Tool ID,
   `in_progress` status and replacement `content`. Existing sequence replay
   supplies reconnecting clients; context reconstruction ignores previews and
   includes only the terminal Tool result. No progress payload enters logs or
   OTLP and no per-update span is added.

Publication is an invalidation hint, not direct event delivery. A delayed
post-commit hint (including one from a worker that just lost ownership) causes
the connection to reread its durable sequence; it cannot send an older preview
after the terminal Tool event. Do not add a competing in-memory delivery state
machine or confuse an already-started transaction with a new write after loss
of authority. Accepted transactions keep the existing Session/Run lock ordering.

This is a bounded preview, not a lossless terminal recording. The final result
remains authoritative and follows the existing Tool result size policy.

## Verification

- Unit: immediate/coalesced output, slow sink, UTF-8 and event bounds, silent
  tools, numeric units, late callbacks and failed writes without unhandled tasks.
- Adapter: official HTTP MCP SDK delivers progress before final response,
  preserving request association and existing execution fencing.
- Application: start -> previews -> terminal ordering; cancellation/unknown
  outcome and persistence failure retain their existing meanings.
- PostgreSQL + ACP v1/v2: live delivery before completion, durable replay,
  identity isolation, terminal-state guards and preview-free model context.
- Separate Gateway + actual Rust Runtime deployment integration passed all 12
  v1/v2 Bash / managed MCP success, error and cancel paths, with live output,
  complete reconnect replay and 12 Jaeger chains. See the [reusable profile](../../../scripts/acp-progress/README.md).
  This evidence supplements, rather than substitutes for, the service tests.

References: [Runtime contract](../../../runtimes/antnest-runtime/docs/tool-progress.md),
[ACP Tool updates](https://agentclientprotocol.com/protocol/v1/tool-calls),
[MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress).
