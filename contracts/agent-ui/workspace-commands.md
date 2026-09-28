# Workspace control commands v1

Status: backend acceptance passed; browser preview awaits human style review
and frontend regression. Owner: Agent UI. Reviewed boundaries: ACP
remains the Session/Run authority; Edge Gateway retains authentication, CSRF and
trusted identity injection. Future Channel Manager is a pending consumer of
these semantics, not an implemented integration. Its scope is recorded in the
[Stage 4 service plan](../../docs/stage-4-services.md); a channel-facing contract
remains to be designed.

## Discovery and execution

Agent View adds `controlCommands`, a replaceable catalogue in the same public
`{name, description, input?: {hint}}` shape as ACP commands. These are workspace
controls, not ACP `available_commands_update` entries. Session `availableCommands`
retains the native Agent catalogue. Workspace names/aliases are reserved;
completion merges both catalogues with workspace precedence and suppresses any
reserved native name, including a temporarily unavailable workspace command.

`POST /agents/{agentId}/commands` receives `{text, sessionId,
expectedConfigurationToken?, expectedRunId?, operationId?}`. `sessionId` is nullable.
The entire message must be a single control command; attachments are rejected
by the client and are not accepted by this endpoint. Exact first-token matching
supports leading whitespace and aliases; unknown commands stay native prompts
in the composer, while this endpoint rejects them. No shell evaluation, fuzzy
mutation matching, model invocation or automatic retries occur.

Responses are `{command, text, selection?: {sessionId}, configurationChanged?}`.
Text is bounded, transient control feedback, not model conversation history or
a fabricated Run. A selection changes only the requesting entry point. Late
responses must not change a different selected Agent/Session or clear a newer
draft. Browser rendering retains at most the latest response for the selection
and clears it on identity/selection changes. Channels can render the same text
and apply the same selection to their own conversation binding.

All requests repeat Agent access and, where relevant, Session ownership checks.
Control calls do not acquire the ordinary Prompt Run slot. Existing conditional
configuration and targeted cancellation preconditions are preserved; read-only
commands can operate during a Run. This route is private Workspace HTTP, not a
new ACP standard method.

## Initial commands

| Name | Aliases | Scope and behavior |
| --- | --- | --- |
| `/help [command]` | `/帮助` | Show current workspace/native catalogue or one command; available before a Session exists |
| `/status` | — | Read Agent availability, selected Session and active work without interrupting execution |
| `/usage` | — | Selected Session's reported context/cost; absent measurements stay unknown |
| `/new` | — | Select an empty local draft; allocate no Session until its first ordinary prompt; preserve existing work |
| `/sessions [cursor]` | — | One authorized page of Sessions and the opaque next cursor |
| `/resume [sessionId]` | — | Without argument list Sessions; otherwise authorize the exact ID before returning selection |
| `/fork` | — | Experimental: fork the selected idle Session through the SDK's UNSTABLE `session/fork`; select only on confirmed success |
| `/model [value]` | — | Read options/current value or set the selected Session's advertised model |
| `/mode [value]` | — | Read/set the advertised authorization mode |
| `/thinking [value]` | — | Read/set advertised `thought_level` when supported |
| `/stop` | — | Cancel the selected Session's observed operation using its exact operation ID and expected Run ID |

Configuration arguments accept an exact advertised value or an unambiguous
exact display name. No prefix selection is allowed. Writes require the
client-observed configuration token and take effect on later admissions, as
existing configuration controls do. Stop requires both operation and Run IDs
from the observed selection; it never guesses another active Session.

`session/fork` is an **UNSTABLE SDK capability**, not a stable ACP v1 requirement.
It can be negotiated on a v1 connection through `agentCapabilities.sessionCapabilities.fork`;
the protocol version alone does not imply support. The previous SDK 1.4.0 and
the [SDK 1.5.0 schema](https://raw.githubusercontent.com/agentclientprotocol/typescript-sdk/v1.5.0/schema/schema.json)
both mark its request, response and capability unstable (checked 2026-09-26).
The ACP service already implements and advertises it; this UI batch exposes
that existing capability. Passing its tests does not make it stable protocol.

Fork is advertised only when upstream advertises/supports it. Like existing
Session creation, a lost fork response may leave a created Session: refresh
the directory and inspect it; do not retry automatically. This batch introduces
no durable creation idempotency promise.

## Delivery and admission

1. Shared contract and failing service tests.
2. Agent UI Node command registry, dispatcher and existing ACP adapters; unit,
   HTTP/SSE contract/component and backend Docker gates first. Backend-only
   acceptance is independent of human style approval.
3. Browser consumer, draft/busy input handling and transient command feedback;
   demonstrate the deployed interface before the user-requested UI regression.
4. Browser integration after the requested style review, building on backend
   evidence for busy status/stop, configuration CAS, scope denial and no model
   calls for controls. A preview is not final acceptance.

Channel bindings, external delivery deduplication, Skill Registry, Task Scheduler,
`/queue` and `/steer` remain pending separate deliveries. No new service is
created by this preparation batch.
