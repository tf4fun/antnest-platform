import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { fileContent } from "./file-content.js";
import { v2Configuration } from "../configuration.js";
import { permissionRequest, v2Permission } from "../permission-request.js";
import type { PermissionConnectionsPort } from "../../../ports/tool-permissions.js";
import { createAcpDispatcher } from "../../../telemetry/acp-dispatch.js";

import { DomainError } from "../../../domain/errors.js";
import { availableCommands } from "../../../domain/slash-commands.js";
import type { ClientMcpInput } from "../../../domain/mcp.js";
import type { ConnectionBinding, ContentBlock } from "../../../domain/types.js";
import type {
  AcpApplicationPort,
  AcceptedAcpRun,
  SessionEvent,
} from "../../../ports/acp-application.js";
import { AgentControllerError } from "../../../ports/agent-controller.js";
import { SessionOutputStreams, sessionOutputKey } from "../session-output.js";

export type CreateAcpAgentInput = {
  binding: ConnectionBinding;
  promptCapabilities: { image: boolean; embeddedContext: boolean; audio?: boolean };
  application: AcpApplicationPort;
  outputs?: SessionOutputStreams;
  permissions?: PermissionConnectionsPort;
};

export function createAcpV2Agent({
  binding,
  promptCapabilities,
  application,
  outputs = new SessionOutputStreams(),
  permissions,
}: CreateAcpAgentInput): acp.AgentApp {
  const dispatch = createAcpDispatcher("v2", binding);
  let connection: acp.AgentConnection;
  const attachPermission = (sessionId: string) =>
    permissions?.attach({
      binding,
      sessionId,
      signal: connection.signal,
      request: (request, signal) =>
        permissionRequest(
          () =>
            connection.client.request(
              acp.methods.client.session.requestPermission,
              v2Permission(request),
              { cancellationSignal: signal },
            ),
          signal,
          (error) => connection.close(error),
        ),
    });
  const sessionSetup = async (sessionId: string) => {
    const result = v2Configuration(
      await mapError(() => application.getSessionConfiguration({ binding, sessionId })),
    );
    await connection.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: availableCommands(),
      },
    });
    return result;
  };
  const attach = async (sessionId: string) => {
    const output = await mapError(() => application.readSessionOutput({ binding, sessionId }));
    await outputs.attach({
      keepExisting: true,
      afterSequence: output.sequence,
      initialState: output.state,
      key: sessionOutputKey(binding, sessionId),
      connectionId: binding.connectionId,
      signal: connection.signal,
      onFailure: (error) => connection.close(error),
      read: (cursor) =>
        application.readSessionOutput({
          binding,
          sessionId,
          ...(cursor === undefined ? {} : { afterSequence: cursor }),
        }),
      send: (event) =>
        sendEvent(event, (update) =>
          connection.client.notify(acp.methods.client.session.update, { sessionId, update }),
        ),
    });
    attachPermission(sessionId);
  };
  return acp
    .agent({ name: "antnest-agent-acp-service" })
    .onConnect((opened) => {
      connection = opened;
      void opened.closed.then(() => outputs.disconnect(binding.connectionId));
    })
    .onRequest(acp.methods.agent.initialize, ({ params, requestId }) =>
      dispatch("initialize", params, requestId, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        info: {
          name: "antnest-agent-acp-service",
          title: "Antnest Agent",
          version: "0.1.0",
        },
        capabilities: {
          session: {
            delete: {},
            fork: {},
            prompt: {
              ...(promptCapabilities.image ? { image: {} } : {}),
              ...(promptCapabilities.audio ? { audio: {} } : {}),
              ...(promptCapabilities.embeddedContext ? { embeddedContext: {} } : {}),
            },
          },
        },
      })),
    )
    .onRequest(acp.methods.agent.session.new, ({ params, requestId }) =>
      dispatch("session/new", params, requestId, async () => {
        const result = await mapError(() =>
          application.createSession({
            binding,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers ?? []),
          }),
        );
        await attach(result.sessionId);
        return { ...result, ...(await sessionSetup(result.sessionId)) };
      }),
    )
    .onRequest(acp.methods.agent.session.list, ({ params, requestId }) =>
      dispatch("session/list", params, requestId, async () => {
        const result = await mapError(() =>
          application.listSessions({
            binding,
            ...(params.cwd === null || params.cwd === undefined ? {} : { cwd: params.cwd }),
            ...(params.cursor === null || params.cursor === undefined
              ? {}
              : { cursor: params.cursor }),
          }),
        );
        return {
          sessions: result.sessions.map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
          })),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        };
      }),
    )
    .onRequest(acp.methods.agent.session.delete, ({ params, requestId }) =>
      dispatch("session/delete", params, requestId, async () => {
        await mapError(() => application.deleteSession({ binding, sessionId: params.sessionId }));
        permissions?.detach(params.sessionId);
        return {};
      }),
    )
    .onRequest(acp.methods.agent.session.fork, ({ params, requestId }) =>
      dispatch("session/fork", params, requestId, async () => {
        const result = await mapError(() =>
          application.forkSession({
            binding,
            sessionId: params.sessionId,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers ?? []),
          }),
        );
        await attach(result.sessionId);
        return { ...result, ...(await sessionSetup(result.sessionId)) };
      }),
    )
    .onRequest(acp.methods.agent.session.resume, ({ params, client, requestId }) =>
      dispatch("session/resume", params, requestId, async () => {
        if (
          params.replayFrom !== null &&
          params.replayFrom !== undefined &&
          params.replayFrom.type !== "start"
        ) {
          throw acp.RequestError.invalidParams(
            { replayFrom: params.replayFrom },
            "Only replayFrom=start is supported",
          );
        }
        const result = await mapError(() =>
          application.resumeSession({
            binding,
            sessionId: params.sessionId,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers ?? []),
            replayFromStart: params.replayFrom?.type === "start",
          }),
        );
        for (const event of result.replay) {
          await sendEvent(event, (update) =>
            client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update,
            }),
          );
        }
        const initialState = result.replay.find((event) => event.kind === "state");
        await outputs.attach({
          key: sessionOutputKey(binding, params.sessionId),
          connectionId: binding.connectionId,
          afterSequence: result.sequence,
          ...(initialState === undefined ? {} : { initialState }),
          signal: connection.signal,
          onFailure: (error) => connection.close(error),
          read: (cursor) =>
            application.readSessionOutput({
              binding,
              sessionId: params.sessionId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
            }),
          send: (event) =>
            sendEvent(event, (update) =>
              client.notify(acp.methods.client.session.update, {
                sessionId: params.sessionId,
                update,
              }),
            ),
        });
        attachPermission(params.sessionId);
        return sessionSetup(params.sessionId);
      }),
    )
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params, requestId }) =>
      dispatch("session/set_config_option", params, requestId, async () => {
        if (params.type !== "id" && params.type !== "boolean")
          throw acp.RequestError.invalidParams(undefined, "Unsupported configuration value type");
        if (typeof params.value !== "string" && typeof params.value !== "boolean")
          throw acp.RequestError.invalidParams(undefined, "Unsupported configuration value");
        await attach(params.sessionId);
        const result = await mapError(() =>
          application.setSessionConfiguration({
            binding,
            sessionId: params.sessionId,
            configId: params.configId,
            value: params.value as string | boolean,
          }),
        );
        const key = sessionOutputKey(binding, params.sessionId);
        outputs.invalidate(key);
        await outputs.flush(key, binding.connectionId);
        return v2Configuration(result);
      }),
    )
    .onRequest(acp.methods.agent.session.close, ({ params, requestId }) =>
      dispatch("session/close", params, requestId, async () => {
        await mapError(() => application.closeSession({ binding, sessionId: params.sessionId }));
        permissions?.detach(params.sessionId);
        return {};
      }),
    )
    .onRequest(acp.methods.agent.session.prompt, ({ params, requestId }) =>
      dispatch("session/prompt", params, requestId, async () => {
        if (!isPromptSupported(params.prompt, promptCapabilities)) {
          await mapError(() => application.assertAccess({ binding }));
          assertPromptSupported(params.prompt, promptCapabilities);
        }
        const accepted = await mapError(() =>
          application.acceptPrompt({
            binding,
            sessionId: params.sessionId,
            prompt: toDomainContent(params.prompt),
          }),
        );
        attachPermission(params.sessionId);
        setImmediate(() => {
          void startRun({
            application,
            accepted,
            sessionId: params.sessionId,
            prompt: params.prompt,
            connection,
            outputs,
            binding,
          });
        });
        return {};
      }),
    )
    .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
      dispatch("session/cancel", params, undefined, () =>
        mapError(() => application.cancelRun({ binding, sessionId: params.sessionId })),
      ),
    );
}

async function startRun({
  application,
  accepted,
  sessionId,
  prompt,
  connection,
  outputs,
  binding,
}: {
  application: AcpApplicationPort;
  accepted: AcceptedAcpRun;
  sessionId: string;
  prompt: acp.ContentBlock[];
  connection: acp.AgentConnection;
  outputs: SessionOutputStreams;
  binding: ConnectionBinding;
}): Promise<void> {
  const key = sessionOutputKey(binding, sessionId);
  const client = connection.client;
  try {
    await outputs.attach({
      key,
      connectionId: binding.connectionId,
      signal: connection.signal,
      onFailure: (error) => connection.close(error),
      waitForDelivery: false,
      read: (cursor) =>
        application.readSessionOutput({
          binding,
          sessionId,
          ...(cursor === undefined ? {} : { afterSequence: cursor }),
        }),
      send: (event) =>
        event.kind === "user_message" && event.messageId === accepted.userMessageId
          ? Promise.resolve()
          : sendEvent(event, (update) =>
              client.notify(acp.methods.client.session.update, { sessionId, update }),
            ),
      beforeFirst: async () => {
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: toAcpUpdate({
            kind: "user_message",
            messageId: accepted.userMessageId,
            content: toDomainContent(prompt),
          }),
        });
        if (accepted.sessionInfoUpdate !== undefined)
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "session_info_update", ...accepted.sessionInfoUpdate },
          });
      },
    });
    await application.executeRun({
      accepted,
      publish: () => {
        outputs.invalidate(key);
        return Promise.resolve();
      },
      signal: new AbortController().signal,
    });
  } catch (error) {
    connection.close(error);
  } finally {
    outputs.invalidate(key);
    await outputs.flush(key, binding.connectionId);
  }
}

async function sendEvent(
  event: SessionEvent,
  send: (update: acp.SessionUpdate) => Promise<void>,
): Promise<void> {
  if (
    (event.kind === "agent_message" || event.kind === "agent_thought") &&
    event.responseId !== undefined
  ) {
    for (const content of event.content) {
      await send({
        sessionUpdate:
          event.kind === "agent_message" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: event.responseId,
        content: content as acp.ContentBlock,
      });
    }
    return;
  }
  await send(toAcpUpdate(event));
}

function toAcpUpdate(event: SessionEvent): acp.SessionUpdate {
  switch (event.kind) {
    case "configuration":
      return { sessionUpdate: "config_option_update", ...v2Configuration(event.configuration) };
    case "plan":
      return {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: "current", entries: event.entries },
      };
    case "user_message":
    case "agent_message":
    case "agent_thought":
      return {
        sessionUpdate: event.kind,
        messageId: event.messageId,
        content: event.content as acp.ContentBlock[],
      };
    case "tool_call":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        ...(event.toolKind === undefined ? {} : { kind: event.toolKind }),
        ...(event.file === undefined
          ? event.locations === undefined
            ? {}
            : { locations: event.locations }
          : { locations: [{ path: event.file.path }] }),
        ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
        ...(event.modelName === undefined ? {} : { name: event.modelName }),
        ...(event.title === undefined ? {} : { title: event.title }),
        ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
        status: event.status,
        ...(event.content === undefined && event.file === undefined
          ? {}
          : {
              content: [
                ...(event.content ?? []).map((content) => ({
                  type: "content" as const,
                  content: content,
                })),
                ...fileContent(event.file),
              ],
            }),
      };
    case "usage":
      return {
        sessionUpdate: "usage_update",
        used: event.used,
        size: event.size,
        ...(event.cost === undefined ? {} : { cost: event.cost }),
      };
    case "state":
      return {
        sessionUpdate: "state_update",
        state: event.state,
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
      };
  }
}

function toDomainContent(content: readonly acp.ContentBlock[]): ContentBlock[] {
  return content.map((block) => structuredClone(block) as ContentBlock);
}

function assertPromptSupported(
  content: readonly acp.ContentBlock[],
  capabilities: CreateAcpAgentInput["promptCapabilities"],
): void {
  for (const block of content) {
    const supported =
      block.type === "text" ||
      block.type === "resource_link" ||
      (block.type === "image" && capabilities.image) ||
      (block.type === "audio" && capabilities.audio === true) ||
      (block.type === "resource" && capabilities.embeddedContext);
    if (!supported) {
      throw acp.RequestError.invalidParams(
        { contentType: block.type },
        `Prompt content type ${block.type} is not supported by this Agent`,
      );
    }
  }
}

function isPromptSupported(
  content: readonly acp.ContentBlock[],
  capabilities: CreateAcpAgentInput["promptCapabilities"],
): boolean {
  return content.every(
    (block) =>
      block.type === "text" ||
      block.type === "resource_link" ||
      (block.type === "image" && capabilities.image) ||
      (block.type === "audio" && capabilities.audio === true) ||
      (block.type === "resource" && capabilities.embeddedContext),
  );
}

function toClientMcpInputs(servers: readonly acp.McpServer[]): ClientMcpInput[] {
  return servers.map((server) => structuredClone(server) as ClientMcpInput);
}

async function mapError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof acp.RequestError) {
      throw error;
    }
    if (error instanceof DomainError) {
      throw Object.assign(
        new acp.RequestError(-32020, error.message, {
          code: error.code,
          retryable: false,
        }),
        { cause: error },
      );
    }
    if (error instanceof AgentControllerError) {
      throw Object.assign(
        new acp.RequestError(-32021, error.message, {
          code: error.code,
          retryable: error.retryable,
        }),
        { cause: error },
      );
    }
    throw error;
  }
}
