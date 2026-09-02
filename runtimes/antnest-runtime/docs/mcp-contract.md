# Runtime MCP Contract

## Protocol

Runtime implements MCP `2026-07-28` with the official Rust `rmcp` `3.1.4` SDK and its
Streamable HTTP server transport.

- MCP endpoint: `POST /mcp`.
- Status endpoint: `GET /status`.
- The server advertises tools only.
- The server is stateless at the MCP protocol layer.
- Internal platform networking is trusted; Runtime does not implement MCP
  authorization or OAuth.
- Dynamic Docker/Kubernetes Host names are accepted. Platform network isolation,
  not HTTP Host validation, prevents external access.
- The SDK owns MCP request metadata, version compatibility, cancellation,
  JSON-RPC envelopes, and Streamable HTTP behavior.

Antnest tests the SDK-facing tool list and calls. It does not copy the complete
MCP specification into a local schema.

## Status

`GET /status` returns HTTP 200 and this exact shape after bootstrap:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "execution_id": "d83f89db-74f3-49df-a3b8-83d6718a45fd",
  "status": "ready"
}
```

`execution_id` is generated once by Runtime PID 1 and changes after every
process restart, even when Agent ID, generation, endpoint, and container remain
the same. It is a consistency identity, not a credential.

Every `POST /mcp` request must carry
`X-Antnest-Expected-Execution-ID: <execution_id>`. Runtime rejects a missing or
stale value with HTTP 409 before the MCP SDK or any Tool sees the request. A
caller obtains the value from the immutable Run execution snapshot populated
after Runtime Controller verifies `/status`.

`status` is always `ready` in a successful response. Before Runtime is
ready, the HTTP listener is not exposed. Unreachable status means unavailable.

## Tools

Runtime enforces one active execution across all four tools. A concurrent call
returns `runtime_busy` immediately; Runtime does not queue calls. Each accepted
call is executed by the matching explicit non-privileged subcommand:

```text
antnest-runtime bash
antnest-runtime read
antnest-runtime write
antnest-runtime edit
```

These are same-binary container-internal execution entries, not Controller APIs.
The subcommand identifies the tool, stdin carries the existing tool input JSON,
and stdout carries one common success/error envelope. No additional public wire
schema or compatibility version is introduced.

### `bash`

Input:

```json
{
  "command": "python script.py",
  "working_dir": {"root": "workspace", "path": "."},
  "env": [{"name": "LANG", "value": "C.UTF-8"}],
  "timeout_ms": 30000
}
```

The working root must be `workspace`. Timeout is between 1 and 86,400,000 ms.
Stdout and stderr are independently bounded to 1 MiB. The MCP result contains a
human-readable text block plus structured content:

```json
{"exit_code": 0, "stdout": "", "stderr": "", "truncated": false}
```

The child starts from an empty environment. Runtime injects `HOME` and `PATH`;
callers may add command-scoped variables but cannot override those two reserved
names or repeat an environment-variable name. Command text must be non-empty
and contain no NUL. Runtime contains and reaps the complete child process tree
before the request finishes.

### `read`

Input:

```json
{
  "path": {"root": "workspace", "path": "notes.txt"},
  "offset": 0,
  "limit": 1048576
}
```

The root may be `workspace` or `system_skills`. Result text is UTF-8 and
bounded to the requested byte range. A non-UTF-8 slice is a tool error rather
than an opaque Base64 response. `offset` is zero or greater; `limit` is between
1 and 8,388,608 bytes.

```json
{"content": "selected UTF-8 text", "truncated": false}
```

### `write`

Input:

```json
{
  "path": {"root": "workspace", "path": "notes.txt"},
  "content": "hello"
}
```

Only `workspace` is writable. UTF-8 content is bounded to 8 MiB and the result
contains `bytes_written`.

```json
{"bytes_written": 5}
```

### `edit`

Input:

```json
{
  "path": {"root": "workspace", "path": "notes.txt"},
  "old_string": "before",
  "new_string": "after"
}
```

`old_string` must occur exactly once. Only `workspace` is editable and the
resulting file cannot exceed 8 MiB.

```json
{"bytes_written": 5}
```

## Errors And Cancellation

Arguments that fail SDK schema decoding are MCP request errors. Semantic input,
filesystem, process, timeout, and content failures return an MCP tool result
with `isError: true`, a concise text block, and structured content containing a
stable `error_code`.

Every completed MCP Tool response carries an explicit effect projection in
`structuredContent`:

| Field | Meaning |
| --- | --- |
| `effect_state=none` | the Tool did not produce an externally visible effect |
| `effect_state=settled` | Runtime received the authoritative completed result |
| `effect_state=unknown` | the operation may have produced an effect, but Runtime cannot prove its final outcome |
| `effect_source` | `runtime_mcp` only when the state is `unknown`; otherwise `null` |

Successful responses retain their existing result fields and add
`effect_state=settled` plus `effect_source=null`. Error responses add
`error_code`, `message`, `effect_state`, and `effect_source`. This projection
is part of the Runtime contract rather than a hint inferred from text or HTTP
status.

A non-zero Bash exit is a completed Bash result, not a transport failure. MCP
Streamable HTTP cancellation is owned by the official SDK; dropping the
request cancels the Execution Actor lease and terminates the complete Executor
process tree.

Runtime does not retry tool calls and does not claim whether an unobserved
side-effecting operation took effect. Agent Controller also keeps one active
Agent operation across conversations and generations, but Runtime independently
enforces its local single-flight invariant.

Stable tool error codes:

| Scope | Codes |
| --- | --- |
| shared execution boundary | `invalid_params`, `runtime_failed`, `runtime_busy`, `runtime_unavailable`, `canceled`, `timeout`, `outcome_unknown`, `encode_result_failed`, `spawn_failed`, `output_capture_failed`, `child_process_containment_unproven` |
| `bash` | `invalid_path`, `wait_failed` |
| `read` | `read_failed`, `content_not_utf8` |
| `write` | `write_failed` |
| `edit` | `edit_read_failed`, `old_string_not_found`, `old_string_not_unique`, `result_too_large`, `edit_failed` |

The exhaustive machine-readable list is `tool_errors` in
`contracts/runtime/contract.json`. Runtime, the Executor process protocol, and
MCP structured errors use one closed `ToolErrorCode`; unknown strings are not
valid Executor responses.

`outcome_unknown` is returned when `bash`, `write`, or `edit` may have produced
a side effect but Runtime did not receive a complete authoritative response.
Filesystem writes use atomic replacement. Failures before `renameat` are
reported as `effect_state=none`; directory synchronization, readback, or
verification failures after `renameat` are reported as
`effect_state=unknown`. Cancellation, timeout, process failure, or response
loss after dispatch is also unknown. Callers must not retry automatically and
should inspect state first.

Every tool path is relative to its named root, non-empty, and free of NUL,
absolute/root components, platform prefixes, and `..` components. These
semantic rules remain authoritative even when a generated JSON Schema cannot
express the complete filesystem invariant.

Relative filesystem paths may appear in structured diagnostic logs. Commands,
environment values, file contents, stdout, and stderr must not be logged by the
Runtime request layer.
