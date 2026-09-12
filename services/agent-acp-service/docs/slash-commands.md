# Slash Commands

## Scope

F08 belongs to Agent ACP Service. It uses the standard
[ACP command contract](https://agentclientprotocol.com/protocol/v1/slash-commands):
advertise `available_commands_update`, execute through `session/prompt`. Both
supported ACP versions use their official SDK. No private command API, new
Controller RPC, command table or Runtime capability is introduced.

The first catalog contains only `/help`, with `/帮助` as a Chinese alias.
Natural-language tasks remain normal prompts; tools, Skills, scheduling and
Session creation are not duplicated as commands. Agent UI can keep using its
existing controls. This service batch does not change the UI or other services.

## Recognition And Execution

1. A single immutable command registry owns names, aliases, descriptions and
   handlers. Advertisements and help output derive from that registry. Aliases
   are not extra menu entries. No command is advertised without a handler.
2. Inspect the first nonempty top-level text block. Only an exact command token
   at its start, followed by whitespace or end of text, is recognized. Paths,
   unknown commands, mentions later in a sentence and embedded resource text
   stay ordinary model input. Do not reinterpret uploaded documents as commands.
3. Keep the complete original prompt and accepted attachments in the existing
   Run intent/history. Help explains the catalog; it does not process appended
   task text or files. Content capability and resource validation still apply.
4. Commands use normal Session authorization, admission, active-Run exclusion,
   cancellation, worker ownership, deadline and terminalization. `/help` is not
   an unauthenticated or disabled-Agent escape hatch. Controller admission is
   still required; help is not a diagnostic fallback for unavailable Controller.
5. Carry the recognized command in the in-process accepted Run only. Its source
   of truth is the persisted prompt; no extra durable command discriminator is
   necessary. Existing interrupted-Run recovery never silently reruns commands.
6. Before model context preparation, execute the deterministic help handler.
   Do not resolve Provider credentials, read Runtime information, discover/call
   MCP tools, invoke a model or fabricate token usage. Persist its answer through
   the normal message event path, then finish locally and close admission.
   Event persistence failures retain existing recovery semantics.

## Notifications And Recovery

After authorized new, load, resume and fork, send one complete current command
catalog for that Session. A failed or foreign Session request sends none.
v1 load includes history replay; v2 resume follows its existing replay rules.
Help replies are ordinary durable assistant content and replay exactly once.
The directory is derived configuration, not a message or permanent event row.

The current catalog is process-static and independent of mode/model settings;
there is no dynamic mutation endpoint or fictitious catalog-change event.
After a service update/reconnect, lifecycle setup sends the current catalog
again, replacing the client's previous list. If dynamic commands are added
later, their actual registry change must send a replacement notification.

This follows Goose's real registry-to-advertisement and Session setup flow
(`acp/response_builder.rs`), not its full command set or private extensions.
v1 delivers command output before the Prompt response; v2 keeps its accepted
response and eventual idle state. Existing request/Run/database/Controller
spans apply; command input and attachment contents are not added to OTLP.

## Acceptance

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
5. Run local admission gates before a separate Gateway/Runtime/Jaeger deployment
   batch. Local tests do not constitute that deployment acceptance.

Service implementation, local verification and the separate
[Gateway deployment batch](../../../scripts/acp-commands/README.md) are complete.
The deployment retains supported file references and explicitly rejects embedded
resources, since production Controller has not advertised that F09 capability.
Final metrics and
explicit fixture/deployment limits are recorded once in
[protocol conformance](protocol-conformance.md#slash-commands-f08-2026-09-09).
