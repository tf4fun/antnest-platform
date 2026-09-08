import * as acp from "@agentclientprotocol/sdk";
import { context, propagation, type TextMapGetter } from "@opentelemetry/api";

import { DomainError } from "../../../domain/errors.js";
import type { ClientMcpInput } from "../../../domain/mcp.js";
import type { ConnectionBinding, ContentBlock } from "../../../domain/types.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
  SessionEvent,
} from "../../../ports/acp-application.js";
import { AgentControllerError } from "../../../ports/agent-controller.js";

export type CreateAcpV1AgentInput = {
  binding: ConnectionBinding;
  promptCapabilities: { image: boolean; embeddedContext: boolean };
  application: AcpApplicationPort;
};

export function createAcpV1Agent({
  binding,
  promptCapabilities,
  application,
}: CreateAcpV1AgentInput): acp.AgentApp {
  let initialized = false;
  return acp
    .agent({ name: "antnest-agent-acp-service-v1" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      if (initialized) {
        throw acp.RequestError.invalidRequest(
          undefined,
          "ACP v1 initialize may only be requested once per connection",
        );
      }
      return withAcpTrace(params._meta, () => {
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
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      requireInitialized(initialized, "session/new");
      return withAcpTrace(params._meta, () =>
        mapError(() =>
          application.createSession({
            binding,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers),
          }),
        ),
      );
    })
    .onRequest(acp.methods.agent.session.load, ({ params, client }) => {
      requireInitialized(initialized, "session/load");
      return withAcpTrace(params._meta, async () => {
        const result = await resume(application, binding, params, true);
        await replay(client, params.sessionId, result.replay);
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.list, ({ params }) => {
      requireInitialized(initialized, "session/list");
      return withAcpTrace(params._meta, async () => {
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
    .onRequest(acp.methods.agent.session.delete, ({ params }) => {
      requireInitialized(initialized, "session/delete");
      return withAcpTrace(params._meta, async () => {
        await mapError(() => application.deleteSession({ binding, sessionId: params.sessionId }));
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.fork, ({ params }) => {
      requireInitialized(initialized, "session/fork");
      return withAcpTrace(params._meta, () =>
        mapError(() =>
          application.forkSession({
            binding,
            sessionId: params.sessionId,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers ?? []),
          }),
        ),
      );
    })
    .onRequest(acp.methods.agent.session.resume, ({ params }) => {
      requireInitialized(initialized, "session/resume");
      return withAcpTrace(params._meta, async () => {
        await resume(application, binding, params, false);
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.close, ({ params }) => {
      requireInitialized(initialized, "session/close");
      return withAcpTrace(params._meta, async () => {
        await mapError(() => application.closeSession({ binding, sessionId: params.sessionId }));
        return {};
      });
    })
    .onRequest(acp.methods.agent.session.prompt, ({ params, client }) => {
      requireInitialized(initialized, "session/prompt");
      return withAcpTrace(params._meta, async () => {
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
        if (accepted.sessionInfoUpdate !== undefined) {
          await notifyBestEffort(client, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "session_info_update",
              ...accepted.sessionInfoUpdate,
            },
          });
        }
        const result = await application.executeRun({
          accepted,
          publish: publisher(client, params.sessionId),
          signal: new AbortController().signal,
        });
        return promptResponse(result);
      });
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      if (!initialized) {
        return;
      }
      return withAcpTrace(params._meta, () =>
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

function publisher(
  client: acp.AgentContext,
  sessionId: string,
): (event: SessionEvent) => Promise<void> {
  return async (event) => {
    for (const update of toAcpUpdates(event)) {
      await notifyBestEffort(client, { sessionId, update });
    }
  };
}

async function notifyBestEffort(
  client: acp.AgentContext,
  params: { sessionId: string; update: acp.SessionUpdate },
): Promise<void> {
  try {
    await client.notify(acp.methods.client.session.update, params);
  } catch {
    // Durable replay, not the socket, is the source of truth.
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
    case "user_message":
      return contentUpdates("user_message_chunk", event.messageId, event.content);
    case "agent_message":
      return contentUpdates("agent_message_chunk", event.messageId, event.content);
    case "agent_thought":
      return contentUpdates("agent_thought_chunk", event.messageId, event.content);
    case "tool_call":
      return [toAcpToolUpdate(event)];
    case "usage":
      return [{ sessionUpdate: "usage_update", used: event.used, size: event.size }];
    case "state":
      return [];
  }
}

function toAcpToolUpdate(event: Extract<SessionEvent, { kind: "tool_call" }>): acp.SessionUpdate {
  const fields = {
    toolCallId: event.toolCallId,
    ...(event.modelName === undefined ? {} : { name: event.modelName }),
    ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
    status: event.status === "cancelled" ? ("failed" as const) : event.status,
    ...(event.content === undefined
      ? {}
      : {
          content: event.content.map((content) => ({
            type: "content" as const,
            content: content as acp.ContentBlock,
          })),
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
    (block.type === "resource" && capabilities.embeddedContext)
  );
}

function toClientMcpInputs(servers: readonly acp.McpServer[]): ClientMcpInput[] {
  return servers.map((server) => structuredClone(server) as ClientMcpInput);
}

function withAcpTrace<Result>(
  metadata: { [key: string]: unknown } | null | undefined,
  operation: () => Result,
): Result {
  if (metadata === null || metadata === undefined) {
    return operation();
  }
  const requestContext = propagation.extract(context.active(), metadata, META_GETTER);
  return context.with(requestContext, operation);
}

const META_GETTER: TextMapGetter<{ [key: string]: unknown }> = {
  keys: (metadata) => Object.keys(metadata),
  get: (metadata, key) => {
    const value = metadata[key];
    return typeof value === "string" || Array.isArray(value) ? value : undefined;
  },
};

async function mapError<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof acp.RequestError) {
      throw error;
    }
    if (error instanceof DomainError) {
      throw new acp.RequestError(-32020, error.message, {
        code: error.code,
        retryable: false,
      });
    }
    if (error instanceof AgentControllerError) {
      throw new acp.RequestError(-32021, error.message, {
        code: error.code,
        retryable: error.retryable,
      });
    }
    throw error;
  }
}
