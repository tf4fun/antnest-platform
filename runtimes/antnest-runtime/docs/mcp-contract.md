# Runtime MCP Contract

This document defines the MCP surface that the Antnest Runtime exposes inside an
Agent container: the protocol endpoints, the status and information resources,
built-in and managed tools, the private Skill maintenance boundary, and error
and cancellation semantics.

## Protocol

Runtime implements MCP `2026-07-28` with the official Rust `rmcp` `3.4.1` SDK and its
Streamable HTTP server transport.

- MCP endpoint: `POST /mcp`.
- Full status endpoint: authenticated `GET /status`; reduced Docker liveness:
  identity-free `GET/HEAD /status/live`.
- The server advertises tools and one read-only Runtime information resource.
- The server is stateless at the MCP protocol layer.
- RC-issued per-instance service tokens authenticate all MCP methods/subpaths
  and private Skill routes before SDK dispatch. ACP alone may execute; RC and ACP
  may read full status. This is workload admission, not end-user OAuth.
- Only the server-owned `antnest-runtime-<agent_id>` alias and loopback hosts with
  the exact listen port pass Host admission. No wildcard or request-selected
  hostname is trusted. See the [instance contract](../../../contracts/runtime/instance-connection.md).
- The SDK owns MCP request metadata, version compatibility, cancellation,
  JSON-RPC envelopes, and Streamable HTTP behavior.

Antnest tests the SDK-facing tool list and calls. It does not copy the complete
MCP specification into a local schema.

### Skill Maintenance Boundary

The [learning design](../../../docs/skill-learning-design.md) and
[learning API contract](../../../contracts/skill-learning/learning-api.md) define a separate
`POST /internal/skill-maintenance/{action}` control endpoint, not a Tool or an
additional built-in. It must not appear in `tools/list`, the information Resource,
or model definitions. Ordinary `tools/call` must reject reserved maintenance
names even if a caller guesses them; managed tools cannot claim these names.

The endpoint requires an ACP-signed request bound to the Agent, current execution,
maintenance job/generation, action, request and content/parameter digest. RC
bootstraps at most two verification keys (current/next); the request selects a
`kid`. Missing verification configuration keeps maintenance closed, and unknown
kids or invalid signatures are rejected without blocking ordinary MCP calls.
The complete trusted set enters the deployment digest and is frozen in each
accepted RC operation; recovery cannot substitute newly configured keys.
RuntimeSpec is immutable, so trusted-set changes require explicit rebuild.
Preloaded next-key signing can switch after deployment checks; removing an old
trusted key cannot happen through an ACP-only change. Compromise requires the
design's isolation/rebuild procedure, including stopping affected Runtimes when
maintenance cannot be isolated. `X-Antnest-Expected-Execution-ID` remains only a consistency
identity and cannot authorize this path. ACP's internal-origin check is a second
layer. All file operations still use the Execution Actor and UID/GID 1000 executor.

Runtime rejects `antnest_skill_maintenance_` and `antnest_skill_temporary_`
names in ordinary `tools/call` and validates up to two Ed25519 public keys in
RuntimeSpec. The private HTTP route rejects missing or invalid credentials
before a request can reach the actor, and checks the ticket signature, action,
body digest, Agent, execution and time. The private executor subcommands also
reject direct invocation by UID 1000, so an Agent Bash call cannot bypass the
HTTP ticket check.

The separate [temporary Skill contract](../../../contracts/runtime/temporary-skills.md)
defines signed install and release endpoints, ordinary read and foreground Bash
use, effect-aware receipts and local cleanup. These operations stay outside
`tools/list` and outside personal and system Skill discovery.

#### Request parsing

For `check`, `commit`, `observe`, `cancel` and `release`, the route strictly
parses the bounded JSON body and binds the request ID, job and generation to
the ticket. `prepare` parses exactly two bounded multipart parts after
verifying the signature over the raw body. It checks Registry v1 manifest
examples, archive paths, types and limits, and artifact and content identities
against the signed metadata.

The route passes valid `prepare`, `check`, `commit`, `observe`, `cancel` and
`release` requests through the Execution Actor to the UID/GID 1000 executor.

#### Actions

- `prepare` writes a hidden, no-overwrite candidate tree with a bounded
  receipt and binds it to the current execution ID. On an exact retry it
  verifies the original expected base digest and the existing bytes. It
  returns a storage key.
- `check` independently validates the complete candidate inventory and the
  canonical content digest.
- `commit` checks the saved check marker, the active base digest and the
  candidate bytes. It records an intent before atomic directory installation,
  then verifies the active digest.
- `observe` reads the persisted commit intent and the current active digest,
  including after a restart. A missing, ambiguous or unreadable intent remains
  `unknown`; changed active content is `conflict`.
- `cancel` closes the in-memory generation, cancels and waits for active
  Runtime maintenance executors, then persists a cancellation marker in the
  workspace volume. `prepare`, `check` and `commit` reject that generation,
  including after a Runtime restart.
- `release` checks the stored identity and content, atomically detaches one
  hidden directory, and keeps an idempotent completion receipt.

#### Filesystem and process guarantees

`commit` uses `RENAME_NOREPLACE` and `RENAME_EXCHANGE` together with directory
`fsync` on the workspace volume.

The Actor holds its single execution slot during maintenance and blocks
conservatively when live child ownership cannot be established.
`ChildRegistry` scans for live direct children outside its managed set. It
retains Bash process groups after their launching shell exits, and scans
managed MCP descendants while excluding the idle server process itself. Commit
admission returns a bounded blocker identity and releases the execution slot;
unknown children remain fail-closed. A managed MCP child that survives its Tool
reply is reported with blocked reason `managed_call_in_flight` and subject
`managed:<server id>`, and the commit is allowed after the child exits.

Hidden storage is capped at 256 MiB. The scanner includes candidates and
detached release trees, rejects symlinks, and checks capacity before each new
hidden write. A write that would exceed the cap fails with
`skill_storage_full`; the caller can release space and retry.

Ordinary MCP keeps its trusted-network policy. `tools/list` remains the sole
authority for model-callable tools.

#### Tests

- Linux executor tests cover ownership, duplicate requests, restart identity,
  drift rejection, conditional create and commit replay. Deterministic executor
  tests model the window after the exchange and before the receipt in `commit`,
  and the windows after detach and after unlink in `release`, without relying
  on SIGKILL timing.
- Linux unit tests in `runtimes/antnest-runtime/src/roots.rs` cover
  `RENAME_NOREPLACE` and `RENAME_EXCHANGE`.
  `tests/integration/antnest-runtime/processes.rs` covers the live-child scan
  in `ChildRegistry`, including Bash background groups and managed MCP
  descendants.
- `tests/integration/antnest-runtime/executor_cli.rs` covers candidate
  preparation as UID 1000, conditional atomic commit, and rejection of direct
  maintenance subcommand invocation by the Agent user.
- `tests/integration/antnest-runtime/mcp_wire.rs` covers the private HTTP route
  without trusted credentials, signed but invalid control bodies, and multipart
  `prepare` validation.
- `make e2e-skill-learning-runtime` runs the Docker HTTP flow on a named
  volume. It starts a Bash background process, observes the blocked receipt,
  stops it through a normal Bash call and completes the commit; repeats the
  blocker check with an official SDK managed MCP fixture; covers lost responses,
  normal Runtime restarts, cancellation and later observation; covers candidate
  cleanup after cancellation and replay after a same-name directory appears;
  and fills hidden storage until `skill_storage_full`, releases space and
  retries successfully.

## Status

`GET /status` returns HTTP 200 and this exact shape after bootstrap:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "execution_id": "d83f89db-74f3-49df-a3b8-83d6718a45fd",
  "status": "ready",
  "test_features": []
}
```

`execution_id` is generated once by Runtime PID 1 and changes after every
process restart, even when Agent ID, generation, endpoint, and container remain
the same. It is a consistency identity, not a credential.

`test_features` is required and lists the binary's compiled test features.
Release builds return `[]`; a `skill-maintenance-e2e-gate` build returns
`["skill-maintenance-e2e-gate"]`. The same identity fields remain present in
HTTP 503 responses with `status: "unavailable"`. See the
[status contract](../../../contracts/runtime/status.md) and
[schema](../../../contracts/runtime/runtime-status.schema.json). Runtime
Controller must accept this field before these images are deployed; deciding
which images may run is the separate #29 admission policy.

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
names, descriptions, and schemas. Managed stdio tools join this same catalog, alongside the four built-ins, without creating per-server HTTP
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

Responsibilities are split by service: Runtime supplies this resource and
managed stdio hosting; Controllers transport immutable configuration and
publish readiness. ACP reads the resource after Run admission and before model
context construction, budgets it, and preserves the two Skill namespaces.
Refreshing on the next Run avoids caching mutable workspace guidance for an
entire Session. See
[Runtime context and managed MCP](../../../docs/runtime-context-and-managed-mcp.md)
for managed-tool aggregation and stdio dispatch. Skill Registry is outside this
resource.

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
and output schemas remain intact. Elicitation is deferred until the official
SDK supports the required URL flow; no local SDK patch or partial interaction
bridge is maintained. Incoming tool continuations fail before dispatch, and
unexpected child input requirements fail explicitly with unknown effects.
Sampling, roots, resources, prompts and elicitation are not delegated. See
[elicitation](elicitation.md) for the decision and resumption criteria.
Managed connections use the SDK Auto lifecycle, preferring `2026-07-28`
discovery with SDK-managed `2025-11-25` initialization fallback.

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
and stdout carries newline-delimited progress frames followed by one common
success/error envelope. Non-Bash tools emit only the terminal envelope. No
additional public wire schema or compatibility version is introduced.

### Live Progress

Calls carrying `_meta.progressToken` may receive standard
`notifications/progress` before their final result. Bash supplies bounded
stdout/stderr previews; managed tools forward their actual child progress,
rewriting the child token to the outer request token. No token means no
notifications; silent/file tools do not invent progress. The result remains
authoritative, and notifications stop on completion or cancellation. See the
[progress contract](tool-progress.md) for limits, process framing and failure
semantics.

### File Observations

Successful builtin `read`, `write` and `edit` can include
`_meta["io.antnest.runtime/file"]`. It carries the configured absolute target;
writes/edits additionally carry complete observed UTF-8 before/after text or an
explicit omission reason. The JSON-encoded metadata budget is 32 KiB. Existing
`content`, `structuredContent` and tool output schemas remain unchanged. These
facts are not additional model text, progress, a stable inode/version identity,
or a file history. See [File observations](file-observations.md) for the exact
contract.

### `bash`

Input:

```json
{
  "command": "python script.py",
  "working_dir": ".",
  "env": [{ "name": "LANG", "value": "C.UTF-8" }],
  "timeout_ms": 30000
}
```

Only `command` is required. `working_dir` is a string relative to the workspace
or beneath `/workspace/`, and defaults to `.`. `timeout_ms` defaults to 120000
and accepts 1..86400000 ms. The working directory cannot target `/skills/`.
Stdout and stderr are independently bounded to 1 MiB. The MCP result contains a
human-readable text block plus structured content:

```json
{ "exit_code": 0, "stdout": "", "stderr": "", "truncated": false }
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

The public input shapes are frozen in
[builtin-tools.schema.json](../../../contracts/runtime/builtin-tools.schema.json).
String paths relative to the workspace, `~/path`, and `/workspace/path` target
the workspace; `/skills/path` targets the read-only System Skill root. Other
absolute paths, traversal, symlinks and special files remain rejected. Internal
executor messages retain typed named roots; those messages are not model inputs.

Input:

```json
{
  "path": "notes.txt",
  "offset": 1,
  "limit": 2000
}
```

Only `path` is required. `offset` is a 1-based line number, default 1; `limit`
counts lines, defaults to 2000 and accepts 1..20000. UTF-8 output preserves the
original text and line endings, and stops on whole lines at 50 KiB. Follow
`next_offset` when truncated. Invalid UTF-8 and a single line exceeding the
output budget are explicit errors, rather than split Unicode or a cursor that
cannot advance. The original file remains bounded to 8 MiB.

```json
{ "content": "selected UTF-8 text", "truncated": false, "next_offset": null }
```

### `write`

Input:

```json
{
  "path": "notes.txt",
  "content": "hello"
}
```

Only the workspace is writable. Parent directories are created automatically.
UTF-8 content is bounded to 8 MiB and the result contains `bytes_written`.

```json
{ "bytes_written": 5 }
```

### `edit`

Input:

```json
{
  "path": "notes.txt",
  "old_string": "before",
  "new_string": "after"
}
```

`old_string` must occur exactly once. Only `workspace` is editable and the
resulting file cannot exceed 8 MiB.

```json
{ "bytes_written": 5 }
```

## Errors And Cancellation

Arguments that fail SDK schema decoding are MCP request errors. Semantic input,
filesystem, process, timeout, and content failures return an MCP tool result
with `isError: true`, a concise text block, and structured content containing a
stable `error_code`.

Every completed MCP Tool response carries an explicit effect projection in
`structuredContent`:

| Field                  | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `effect_state=none`    | the Tool did not produce an externally visible effect                                 |
| `effect_state=settled` | Runtime received the authoritative completed result                                   |
| `effect_state=unknown` | the operation may have produced an effect, but Runtime cannot prove its final outcome |
| `effect_source`        | `runtime_mcp` only when the state is `unknown`; otherwise `null`                      |

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

| Scope                     | Codes                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared execution boundary | `invalid_params`, `runtime_failed`, `runtime_busy`, `runtime_unavailable`, `canceled`, `timeout`, `outcome_unknown`, `encode_result_failed`, `spawn_failed`, `output_capture_failed`, `child_process_containment_unproven` |
| `bash`                    | `invalid_path`, `wait_failed`, `temporary_background_not_supported`                                                                                                                                                        |
| `read`                    | `read_failed`, `content_not_utf8`, `result_too_large`                                                                                                                                                                      |
| `write`                   | `write_failed`                                                                                                                                                                                                             |
| `edit`                    | `edit_read_failed`, `old_string_not_found`, `old_string_not_unique`, `result_too_large`, `edit_failed`                                                                                                                     |

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

## Managed MCP secret environment

Managed servers have dedicated UIDs 2000..2007 and workspace GID 1000; they do
not share the UID 1000 tools' identity. RuntimeSpec carries only secret_env
set/fingerprint descriptors. The trusted entry reads the RC-owned private
`/run/antnest-mcp/secrets.json` before privilege drop and execs with that server's
values, never another server's values or supervisor configuration. The file is
root-owned 0400 in a 0700 directory on a read-only private mount. Secret values
are absent from Docker Config.Env and the launcher environment. File tools and
Bash use group-writable workspace defaults; explicit private file modes may
exclude managed servers. Every managed UID uses the Executor tunnel and kill
switch. No host ptrace_scope change or hidepid remount is required.

The [shared contract](../../../contracts/runtime/managed-mcp-secrets.md) and
[Linux execve manual](https://man7.org/linux/man-pages/man2/execve.2.html) explain
why dumpability alone does not survive an ordinary exec and cannot isolate
same-UID servers from model-driven tools.
