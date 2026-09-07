# Runtime MCP Contract

## Protocol

Runtime implements MCP `2026-07-28` with the official Rust `rmcp` `3.1.4` SDK and its
Streamable HTTP server transport.

- MCP endpoint: `POST /mcp`.
- Status endpoint: `GET /status`.
- The server advertises tools and one read-only Runtime information resource.
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

## Runtime Information

`resources/list` exposes `antnest://runtime/info` (`application/json`).
`resources/read` for that exact URI returns one text resource whose JSON is
defined by `contracts/runtime/runtime-information.schema.json`. Unknown resource
URIs are rejected. This is an MCP Resource, not a model-selected Tool or
a new Controller RPC. `tools/list` remains authoritative for executable tool
names, descriptions, and schemas. The managed-MCP work adds stdio tools to this
same catalog, alongside the four built-ins, without creating per-server HTTP
endpoints or embedding a second tool catalog in the information Resource.

The resource reports the current process `execution_id`, operating system and
architecture, workspace/home, root `AGENTS.md`, and a compact Skill index.
System Skills are immediate directories beneath `/skills`; Personal Skills are
immediate directories beneath `$HOME/.antnest/skills`. Entries retain source
and named-root path even when display names collide. Neither namespace shadows
the other. Skill YAML frontmatter supplies name and description; full Skill
bodies, scripts, binaries, credentials, and environment dumps are never returned.

Reading the resource enters the same Execution Actor as file tools and runs the
`info` subcommand as UID/GID 1000. The root Supervisor never reads Agent-owned
instruction files itself. Named-root reads reject symlinks and special files;
the resource cannot be used to ask for arbitrary paths. The read is bounded and
cancelable, returns an MCP error with `data.error_code=runtime_busy` when another
execution owns the actor, and does not create a Run, execute a shell command,
or initialize an MCP process.

Resource collection is fresh for every request, with `ttlMs=0` and private
cache scope. Root `AGENTS.md` is optional; nested project instructions remain
on-demand file reads. At most 16 KiB of UTF-8 root guidance is returned, with
explicit truncation. Read only the first 16 KiB of each Skill manifest; complete
YAML frontmatter within that prefix is sufficient even if its body is larger.
Its name and
description are limited to 128 and 512 bytes. Each Skill root scans at most 128
directory entries and returns at most 32 valid Skills. Selection is sorted by
directory name within the bounded scan. Missing instruction/Personal Skill
files are normal empty states. Invalid, unreadable, or oversized manifests are
omitted with bounded path/code warnings; an unreadable System Skill root is
reported, not silently treated as empty. Catalog truncation is explicit.
Returned text is workspace data, not platform authorization or a grant of tools
or network access.

The expected execution header fences this resource just like tools. Resource
list/read export the existing MCP operation spans and metrics, and `info`
execution uses the existing executor span. Neither traces nor request logs
contain instruction bodies, Skill descriptions, or serialized resource content.
The packet-forwarding path remains untraced.

Delivery is split by service: this batch supplies the Runtime resource, managed
stdio MCP hosting and their tests. Controller batches then complete configuration
transport and readiness publication. A later ACP batch reads the resource after Run admission and before model context
construction, includes it in the context budget, and preserves the two Skill
namespaces. Refresh on the next Run avoids caching mutable workspace guidance
for an entire ACP Session. Docker/Jaeger integration follows all service batches.
See [the delivery plan](../../../docs/runtime-context-and-managed-mcp.md) for
managed-tool aggregation and stdio dispatch. Skill Registry remains outside this work.

## Tools

### Managed stdio Tools

`RuntimeSpec.mcp_servers` is an optional array (empty by default) of at most eight
objects: `{id, command, args, env}`. IDs contain 1-16 lowercase ASCII letters,
digits or hyphens and start with a letter. `command` names an executable;
`args` and `env` default to empty. No shell interpolation is performed. The
working directory and HOME are the persistent workspace. Explicit environment
values are applied only after privilege reduction, never to the root launcher.
The encoded configuration array is limited to 64 KiB, leaving room for the
rest of RuntimeSpec within the Linux per-environment-string execution limit.

Runtime starts these processes through its `mcp-stdio` subcommand as UID/GID
1000, clears inherited descriptors and privileges, and uses the official MCP
client SDK on stdin/stdout. Completion of a tool request never clears container
processes. Background jobs may outlive a request, turn, or Run, regardless of
whether they originated from Bash or a managed MCP server. PID 1 reaps exited
orphan processes without signaling live jobs or stealing owned child statuses.

Every configured server must initialize and advertise a valid tool catalog
before Runtime becomes ready. Startup is bounded. The catalog is captured for
the Runtime lifetime; changing configuration or tool definitions requires an
explicit Runtime rebuild. TUN forwarding runs during initialization, so a
non-root MCP program can use its governed network while starting. There is no child restart loop, dynamic registration
API, per-child HTTP endpoint, or control-plane database in Runtime.

`tools/list` combines the four built-ins with managed definitions. A managed
name uses `mcp__<id>__<original-name>`; long names are shortened with a stable hash
suffix to fit the 64-byte model function-name limit. The routing table stores
the original name, and rejects duplicate bindings. Descriptions, input schemas
and output schemas remain intact. Managed tools do not claim support for
server-initiated sampling, elicitation, roots, resources or prompts; this
delivery hosts tool discovery and invocation only.

Startup/discovery shares one 30-second deadline across all configured servers.
The aggregate catalog is bounded to 128 tools and 1 MiB, discovery to 16 pages
per child, and SDK stdio frames to 8 MiB. Managed calls have a 120-second ceiling;
cancellation delivery has a one-second bound. Dots in child tool names are
normalized with a stable hash to avoid collisions in model function names.

All built-in, information and managed calls share the Runtime's execution gate.
Runtime forwards managed arguments and the original tool name using the SDK,
and preserves returned content, structured content and `isError`. Missing
bindings fail before dispatch. A child protocol/transport failure is not a
successful or empty tool result. On cancellation/timeout after dispatch,
Runtime sends SDK cancellation and reports unobserved effects as unknown.
Cancellation does not prove that the child stopped its work, does not terminate
the shared MCP server, and does not cause a whole Runtime restart. Actual loss
of a required managed service is a Runtime lifecycle failure; container restart
policy owns that recovery. No side-effect rollback is claimed.

Startup failure, child exit and shutdown cleanup have bounded lifecycle events.
Managed tool traces use the parent Runtime request trace and bounded operation
labels. They do not record command lines, env values, tool arguments/results or
child stderr. Child stderr is drained without exporting payload content.

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
and contain no NUL. A successful command may leave background jobs running;
redirect their output to a workspace file when it must remain readable across
calls. An inherited output pipe has a bounded drain window, not an unlimited
wait or permission to kill the job. Cancellation/timeout targets only the
current call's process group and reports unobserved effects as unknown. It does
not kill prior calls' jobs or promise containment of deliberately detached
processes. Container stop/replacement owns the complete environment lifetime.

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
request cancels the active invocation and signals its process group. Previous
calls' background jobs remain alive. Deliberately detached jobs are outside that
group and are not claimed to be stopped by request cancellation.

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
