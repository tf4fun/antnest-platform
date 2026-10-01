# Slash Commands

This document describes the built-in slash command registry, how commands are
recognized and executed through `session/prompt`, and how the command catalog
is advertised. Runtime Skill commands are defined separately in the
[Skill command contract](../../../contracts/agent-acp/skill-commands.md).

## Scope

Slash commands use the standard
[ACP command contract](https://agentclientprotocol.com/protocol/v1/slash-commands):
the service advertises `available_commands_update` and executes commands
through `session/prompt`. Both supported ACP versions use their official SDK.
There is no private command API, Controller RPC, command table or Runtime
capability for built-in commands.

The built-in catalog contains only `/help`. The registry also accepts the
localized alias `/帮助`, which is not listed as a separate menu entry.
Natural-language tasks remain normal prompts; tools, scheduling and Session
creation are not duplicated as commands. Agent UI can keep using its existing controls.

## Recognition And Execution

1. A single immutable command registry owns names, aliases, descriptions and
   handlers. Advertisements and help output derive from that registry. Aliases
   are not extra menu entries. No command is advertised without a handler.
2. Inspect the first nonempty top-level text block. Only an exact command token
   at its start, followed by whitespace or end of text, is recognized. Paths,
   unknown commands, mentions later in a sentence and embedded resource text
   stay ordinary model input. Uploaded documents are not reinterpreted as commands.
3. Keep the complete original prompt and accepted attachments in the existing
   Run intent/history. Help explains the catalog; it does not process appended
   task text or files. Content capability and resource validation still apply.
4. Commands use normal Session authorization, admission, active-Run exclusion,
   cancellation, worker ownership, deadline and terminalization. `/help` is not
   an unauthenticated or disabled-Agent escape hatch. ACP checks the locally
   applied execution projection; no Controller Run admission is requested.
5. Carry the recognized command in the in-process accepted Run only. Its source
   of truth is the persisted prompt; no extra durable command discriminator is
   necessary. Existing interrupted-Run recovery never silently reruns commands.
6. Before model context preparation, execute the deterministic help handler.
   Do not resolve Provider credentials, read Runtime information, discover/call
   MCP tools, invoke a model or fabricate token usage. Persist its answer through
   the normal message event path, then finish and release ACP's local execution ownership.
   Event persistence failures retain existing recovery semantics.

## Notifications And Recovery

After authorized new, load, resume and fork, the service sends one complete
current command catalog for that Session. A failed or foreign Session request
sends none. v1 load includes history replay; v2 resume follows its existing
replay rules. Help replies are ordinary durable assistant content and replay
exactly once. The catalog is derived configuration, not a message or permanent event row.

The built-in catalog is process-static and independent of mode/model settings.
After a service update or reconnect, lifecycle setup sends the current catalog
again, replacing the client's previous list. On ACP v1, Runtime Skill commands
are appended to the catalog and refreshed after Runs and learning notices; each
refresh sends a complete replacement catalog. ACP v2 advertises only the
built-in commands.

The catalog follows the registry: each advertisement is derived from the
registry at Session setup rather than from a separately maintained list.
v1 delivers command output before the Prompt response; v2 keeps its accepted
response and eventual idle state. Existing request/Run/database spans apply;
command input and attachment contents are not added to OTLP.

## Verification

1. Registry and parser tests cover aliases, exact token boundaries, whitespace,
   unknown commands, paths, quoted/document input and prompt immutability.
2. Executor tests prove zero Provider/Runtime calls, normal terminal ordering,
   cancellation/deadline/ownership handling and recovery on failed persistence.
3. Official v1/v2 schema and real connection tests cover every advertised
   lifecycle method, complete catalogs, reply ordering and unsupported-client
   behavior. A client may ignore the notification; commands still execute.
4. PostgreSQL protocol tests prove original prompt/attachment retention, help
   replay and fork, process restart, Session isolation, active-Run exclusion,
   disabled identity rejection and a subsequent ordinary model prompt.
5. The [Gateway deployment profile](../../../tests/e2e/acp-commands/README.md)
   (`make e2e-slash-commands`) covers v1 HTTP, v1 WebSocket and v2 WebSocket
   through Gateway, history restoration, isolation and Jaeger ancestry.

Test file locations are listed in
[protocol conformance](protocol-conformance.md#stable-acp-v1-matrix) (rows `V1-COMMAND-01` and `V2-COMMAND-01`).
