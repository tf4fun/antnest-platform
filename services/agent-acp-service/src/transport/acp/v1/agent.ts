import * as acp from "@agentclientprotocol/sdk";
import { fileContent } from "./file-content.js";
import { v1Configuration } from "../configuration.js";
import { permissionRequest, v1Permission } from "../permission-request.js";
import type { PermissionConnectionsPort } from "../../../ports/tool-permissions.js";
import { createAcpDispatcher } from "../../../telemetry/acp-dispatch.js";

import { DomainError } from "../../../domain/errors.js";
import { availableCommands } from "../../../domain/slash-commands.js";
import type { ClientMcpInput } from "../../../domain/mcp.js";
import type { ConnectionBinding, ContentBlock } from "../../../domain/types.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
  SessionEvent,
} from "../../../ports/acp-application.js";
import { SessionOutputStreams, sessionOutputKey } from "../session-output.js";

export type CreateAcpV1AgentInput = {
  binding: ConnectionBinding;
  promptCapabilities: { image: boolean; embeddedContext: boolean; audio?: boolean };
  application: AcpApplicationPort;
  outputs?: SessionOutputStreams;
  permissions?: PermissionConnectionsPort;
};

export function createAcpV1Agent({
  binding,
  promptCapabilities,
  application,
  outputs = new SessionOutputStreams(),
  permissions,
}: CreateAcpV1AgentInput): acp.AgentApp {
  const dispatch = createAcpDispatcher("v1", binding);
  let initialized = false;
  let connection: acp.AgentConnection;
  const attach = async (
    sessionId: string,
    afterSequence?: number,
    beforeFirst?: () => Promise<void>,
    waitForDelivery = true,
    keepExisting = false,
    skipMessageId?: string,
    configurationInResponse = true,
  ) => {
    await outputs.attach({
      keepExisting,
      configurationInResponse,
      identity: binding,
      key: sessionOutputKey(binding, sessionId),
      connectionId: binding.connectionId,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      signal: connection.signal,
      read: (cursor) =>
        application.readSessionOutput({
          binding,
          sessionId,
          ...(cursor === undefined ? {} : { afterSequence: cursor }),
        }),
      send: (event) =>
        event.kind === "user_message" && event.messageId === skipMessageId
          ? Promise.resolve()
          : replay(connection.client, sessionId, [event]),
      onFailure: (error) => connection.close(error),
      ...(beforeFirst === undefined ? {} : { beforeFirst }),
      waitForDelivery,
    });
    permissions?.attach({
      binding,
      sessionId,
      signal: connection.signal,
      request: (request, signal) =>
        permissionRequest(
          () =>
            connection.client.request(
              acp.methods.client.session.requestPermission,
              v1Permission(request),
              { cancellationSignal: signal },
            ),
          signal,
          (error) => connection.close(error),
        ),
    });
  };
  const sessionSetup = async (sessionId: string) => {
    const result = v1Configuration(
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
  const setConfiguration = async (sessionId: string, configId: string, value: string | boolean) => {
    const output = await mapError(() => application.readSessionOutput({ binding, sessionId }));
    await attach(sessionId, output.sequence, undefined, true, true);
    const result = await mapError(() =>
      application.setSessionConfiguration({ binding, sessionId, configId, value }),
    );
    const key = sessionOutputKey(binding, sessionId);
    outputs.invalidate(key);
    await outputs.flush(key, binding.connectionId);
    return v1Configuration(result);
  };
  return acp
    .agent({ name: "antnest-agent-acp-service-v1" })
    .onConnect((opened) => {
      connection = opened;
      void opened.closed.then(() => outputs.disconnect(binding.connectionId));
    })
    .onRequest(acp.methods.agent.initialize, ({ params, requestId }) => {
      return dispatch("initialize", params, requestId, () => {
        if (initialized) {
          throw acp.RequestError.invalidRequest(
            undefined,
            "ACP v1 initialize may only be requested once per connection",
          );
        }
        initialized = true;
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentInfo: {
            name: "antnest-agent-acp-service",
            title: "Antnest Agent",
            version: "0.1.0",
          },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              ...(promptCapabilities.image ? { image: true } : {}),
              ...(promptCapabilities.audio ? { audio: true } : {}),
              ...(promptCapabilities.embeddedContext ? { embeddedContext: true } : {}),
            },
            mcpCapabilities: {},
            sessionCapabilities: {
              list: {},
              delete: {},
              fork: {},
              resume: {},
              close: {},
            },
          },
        };
      });
    })
    .onRequest(acp.methods.agent.session.new, ({ params, requestId }) => {
      return dispatch("session/new", params, requestId, async () => {
        requireInitialized(initialized, "session/new");
        const result = await mapError(() =>
          application.createSession({
            binding,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers),
          }),
        );
        await attach(result.sessionId);
        return { ...result, ...(await sessionSetup(result.sessionId)) };
      });
    })
    .onRequest(acp.methods.agent.session.load, ({ params, client, requestId }) => {
      return dispatch("session/load", params, requestId, async () => {
        requireInitialized(initialized, "session/load");
        const result = await resume(application, binding, params, true);
        await replay(client, params.sessionId, result.replay);
        await attach(params.sessionId, result.sequence);
        return sessionSetup(params.sessionId);
      });
    })
    .onRequest(acp.methods.agent.session.list, ({ params, requestId }) => {
      return dispatch("session/list", params, requestId, async () => {
        requireInitialized(initialized, "session/list");
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
      });
    })
    .onRequest(acp.methods.agent.session.delete, ({ params, requestId }) => {
      return dispatch("session/delete", params, requestId, async () => {
        requireInitialized(initialized, "session/delete");
        await mapError(() => application.deleteSession({ binding, sessionId: params.sessionId }));
        permissions?.detach(params.sessionId);
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.fork, ({ params, requestId }) => {
      return dispatch("session/fork", params, requestId, async () => {
        requireInitialized(initialized, "session/fork");
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
      });
    })
    .onRequest(acp.methods.agent.session.resume, ({ params, requestId }) => {
      return dispatch("session/resume", params, requestId, async () => {
        requireInitialized(initialized, "session/resume");
        const result = await resume(application, binding, params, false);
        await attach(params.sessionId, result.sequence);
        return sessionSetup(params.sessionId);
      });
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params, requestId }) => {
      return dispatch("session/set_config_option", params, requestId, async () => {
        requireInitialized(initialized, "session/set_config_option");
        const result = await setConfiguration(params.sessionId, params.configId, params.value);
        return { configOptions: result.configOptions };
      });
    })
    .onRequest(acp.methods.agent.session.setMode, ({ params, requestId }) => {
      return dispatch("session/set_mode", params, requestId, async () => {
        requireInitialized(initialized, "session/set_mode");
        if (params.modeId === "agent_default")
          throw acp.RequestError.invalidParams(undefined, "Select an advertised mode");
        await setConfiguration(params.sessionId, "mode", params.modeId);
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.close, ({ params, requestId }) => {
      return dispatch("session/close", params, requestId, async () => {
        requireInitialized(initialized, "session/close");
        await mapError(() => application.closeSession({ binding, sessionId: params.sessionId }));
        permissions?.detach(params.sessionId);
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.prompt, ({ params, client, requestId }) => {
      return dispatch("session/prompt", params, requestId, async () => {
        requireInitialized(initialized, "session/prompt");
        if (!isPromptSupported(params.prompt, promptCapabilities)) {
          await mapError(() => application.assertAccess({ binding }));
          assertPromptSupported(params.prompt, promptCapabilities);
        }
        const key = sessionOutputKey(binding, params.sessionId);
        let observing = false;
        const accepted = await mapError(() =>
          application.acceptPrompt({
            binding,
            sessionId: params.sessionId,
            prompt: toDomainContent(params.prompt),
            outputChanged: () => {
              if (observing) outputs.invalidate(key);
            },
          }),
        );
        try {
          await attach(
            params.sessionId,
            accepted.outputSequence,
            async () => {
              if (accepted.sessionInfoUpdate !== undefined)
                await client.notify(acp.methods.client.session.update, {
                  sessionId: params.sessionId,
                  update: { sessionUpdate: "session_info_update", ...accepted.sessionInfoUpdate },
                });
            },
            false,
            false,
            accepted.userMessageId,
            false,
          );
          observing = true;
          outputs.invalidate(key);
          const result = await accepted.completion;
          return promptResponse(result);
        } finally {
          observing = true;
          outputs.invalidate(key);
          await outputs.flush(key, binding.connectionId);
        }
      });
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      if (!initialized) {
        return;
      }
      return dispatch("session/cancel", params, undefined, () =>
        mapError(() => application.cancelRun({ binding, sessionId: params.sessionId })),
      );
    });
}

function resume(
  application: AcpApplicationPort,
  binding: ConnectionBinding,
  params: {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: acp.McpServer[];
  },
  replayFromStart: boolean,
): ReturnType<AcpApplicationPort["resumeSession"]> {
  return mapError(() =>
    application.resumeSession({
      binding,
      sessionId: params.sessionId,
      cwd: params.cwd,
      additionalDirectories: [...(params.additionalDirectories ?? [])],
      mcpServers: toClientMcpInputs(params.mcpServers ?? []),
      replayFromStart,
    }),
  );
}

async function replay(
  client: acp.AgentContext,
  sessionId: string,
  events: readonly SessionEvent[],
): Promise<void> {
  for (const event of events) {
    for (const update of toAcpUpdates(event)) {
      await client.notify(acp.methods.client.session.update, { sessionId, update });
    }
  }
}

function requireInitialized(initialized: boolean, method: string): void {
  if (!initialized) {
    throw acp.RequestError.invalidRequest(
      undefined,
      `ACP v1 connection must be initialized before '${method}'`,
    );
  }
}

function promptResponse(result: ExecuteRunResult): acp.PromptResponse {
  switch (result.terminalClass) {
    case "completed":
      return { stopReason: result.stopReason };
    case "cancelled":
      return { stopReason: "cancelled" };
    case "failed":
      throw new acp.RequestError(-32022, "Agent Run failed", {
        code: result.errorClass,
        retryable: false,
      });
    case "unresolved":
      throw new acp.RequestError(-32023, "Agent Run outcome is unresolved", {
        code: result.errorClass,
        retryable: false,
      });
  }
}

function toAcpUpdates(event: SessionEvent): acp.SessionUpdate[] {
  switch (event.kind) {
    case "configuration":
      return [
        {
          sessionUpdate: "config_option_update",
          configOptions: v1Configuration(event.configuration).configOptions,
        },
        { sessionUpdate: "current_mode_update", currentModeId: event.configuration.modeId },
      ];
    case "plan":
      return [{ sessionUpdate: "plan", entries: event.entries }];
    case "user_message":
      return contentUpdates("user_message_chunk", event.messageId, event.content);
    case "agent_message":
      return contentUpdates(
        "agent_message_chunk",
        event.responseId ?? event.messageId,
        event.content,
      );
    case "agent_thought":
      return contentUpdates(
        "agent_thought_chunk",
        event.responseId ?? event.messageId,
        event.content,
      );
    case "tool_call":
      return [toAcpToolUpdate(event)];
    case "usage":
      return [
        {
          sessionUpdate: "usage_update",
          used: event.used,
          size: event.size,
          ...(event.cost === undefined ? {} : { cost: event.cost }),
        },
      ];
    case "state":
      return [];
  }
}

function toAcpToolUpdate(event: Extract<SessionEvent, { kind: "tool_call" }>): acp.SessionUpdate {
  const locations = event.file === undefined ? event.locations : [{ path: event.file.path }];
  const fields = {
    toolCallId: event.toolCallId,
    ...(event.toolKind === undefined ? {} : { kind: event.toolKind }),
    ...(locations === undefined ? {} : { locations }),
    ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
    ...(event.modelName === undefined ? {} : { name: event.modelName }),
    ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
    status: event.status === "cancelled" ? ("failed" as const) : event.status,
    ...(event.content === undefined && event.file === undefined
      ? {}
      : {
          content: [
            ...(event.content ?? []).map((content) => ({
              type: "content" as const,
              content: content as acp.ContentBlock,
            })),
            ...fileContent(event.file),
          ],
        }),
  };
  if (event.initial) {
    return {
      sessionUpdate: "tool_call",
      title: event.title,
      ...fields,
    };
  }
  return {
    sessionUpdate: "tool_call_update",
    ...(event.title === undefined ? {} : { title: event.title }),
    ...fields,
  };
}

function contentUpdates(
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  content: readonly ContentBlock[],
): acp.SessionUpdate[] {
  return content.map((block) => ({
    sessionUpdate,
    messageId,
    content: block as acp.ContentBlock,
  }));
}

function toDomainContent(content: readonly acp.ContentBlock[]): ContentBlock[] {
  return content.map((block) => structuredClone(block) as ContentBlock);
}

function assertPromptSupported(
  content: readonly acp.ContentBlock[],
  capabilities: CreateAcpV1AgentInput["promptCapabilities"],
): void {
  for (const block of content) {
    if (!isContentSupported(block, capabilities)) {
      throw acp.RequestError.invalidParams(
        { contentType: block.type },
        `Prompt content type ${block.type} is not supported by this Agent`,
      );
    }
  }
}

function isPromptSupported(
  content: readonly acp.ContentBlock[],
  capabilities: CreateAcpV1AgentInput["promptCapabilities"],
): boolean {
  return content.every((block) => isContentSupported(block, capabilities));
}

function isContentSupported(
  block: acp.ContentBlock,
  capabilities: CreateAcpV1AgentInput["promptCapabilities"],
): boolean {
  return (
    block.type === "text" ||
    block.type === "resource_link" ||
    (block.type === "image" && capabilities.image) ||
    (block.type === "audio" && capabilities.audio === true) ||
    (block.type === "resource" && capabilities.embeddedContext)
  );
}

function toClientMcpInputs(servers: readonly acp.McpServer[]): ClientMcpInput[] {
  return servers.map((server) => structuredClone(server) as ClientMcpInput);
}

async function mapError<Result>(operation: () => Promise<Result>): Promise<Result> {
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
    throw error;
  }
}
