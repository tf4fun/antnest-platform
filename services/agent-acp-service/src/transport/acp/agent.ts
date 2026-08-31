import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { context, propagation, type TextMapGetter } from "@opentelemetry/api";

import { DomainError } from "../../domain/errors.js";
import type { ClientMcpInput } from "../../domain/mcp.js";
import type { ConnectionBinding, ContentBlock, TerminalClass } from "../../domain/types.js";
import type {
  AcpApplicationPort,
  AcceptedAcpRun,
  ExecuteRunResult,
  SessionEvent,
} from "../../ports/acp-application.js";
import { AgentControllerError } from "../../ports/agent-controller.js";

export type CreateAcpAgentInput = {
  binding: ConnectionBinding;
  promptCapabilities: { image: boolean; embeddedContext: boolean };
  application: AcpApplicationPort;
};

export function createAcpAgent({
  binding,
  promptCapabilities,
  application,
}: CreateAcpAgentInput): acp.AgentApp {
  return acp
    .agent({ name: "antnest-agent-acp-service" })
    .onRequest(acp.methods.agent.initialize, ({ params }) =>
      withAcpTrace(params._meta, () => ({
        protocolVersion:
          params.protocolVersion === acp.PROTOCOL_VERSION
            ? params.protocolVersion
            : acp.PROTOCOL_VERSION,
        info: {
          name: "antnest-agent-acp-service",
          title: "Antnest Agent",
          version: "0.1.0",
        },
        capabilities: {
          session: {
            delete: {},
            mcp: { http: {} },
            prompt: {
              ...(promptCapabilities.image ? { image: {} } : {}),
              ...(promptCapabilities.embeddedContext ? { embeddedContext: {} } : {}),
            },
          },
        },
      })),
    )
    .onRequest(acp.methods.agent.session.new, ({ params }) =>
      withAcpTrace(params._meta, () =>
        mapError(() =>
          application.createSession({
            binding,
            cwd: params.cwd,
            additionalDirectories: [...(params.additionalDirectories ?? [])],
            mcpServers: toClientMcpInputs(params.mcpServers ?? []),
          }),
        ),
      ),
    )
    .onRequest(acp.methods.agent.session.list, ({ params }) =>
      withAcpTrace(params._meta, async () => {
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
    .onRequest(acp.methods.agent.session.delete, ({ params }) =>
      withAcpTrace(params._meta, async () => {
        await mapError(() => application.deleteSession({ binding, sessionId: params.sessionId }));
        return {};
      }),
    )
    .onRequest(acp.methods.agent.session.resume, ({ params, client }) =>
      withAcpTrace(params._meta, async () => {
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
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: toAcpUpdate(event),
          });
        }
        return {};
      }),
    )
    .onRequest(acp.methods.agent.session.close, ({ params }) =>
      withAcpTrace(params._meta, async () => {
        await mapError(() => application.closeSession({ binding, sessionId: params.sessionId }));
        return {};
      }),
    )
    .onRequest(acp.methods.agent.session.prompt, ({ params, client }) =>
      withAcpTrace(params._meta, async () => {
        assertPromptSupported(params.prompt, promptCapabilities);
        const accepted = await mapError(() =>
          application.acceptPrompt({
            binding,
            sessionId: params.sessionId,
            prompt: toDomainContent(params.prompt),
          }),
        );
        startRun(application, accepted, params.sessionId, params.prompt, client);
        return {};
      }),
    )
    .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
      withAcpTrace(params._meta, () =>
        mapError(() => application.cancelRun({ binding, sessionId: params.sessionId })),
      ),
    );
}

function startRun(
  application: AcpApplicationPort,
  accepted: AcceptedAcpRun,
  sessionId: string,
  prompt: acp.ContentBlock[],
  client: acp.AgentContext,
): void {
  const publish = (event: SessionEvent): Promise<void> => {
    bestEffortNotify(client, {
      sessionId,
      update: toAcpUpdate(event),
    });
    return Promise.resolve();
  };
  bestEffortNotify(client, {
    sessionId,
    update: toAcpUpdate({
      kind: "user_message",
      messageId: accepted.userMessageId,
      content: toDomainContent(prompt),
    }),
  });
  notifyState(client, sessionId, "running");
  const execution = application.executeRun({
    accepted,
    publish,
    signal: new AbortController().signal,
  });
  void execution
    .then((result) => notifyIdle(client, sessionId, result))
    .catch(() => notifyState(client, sessionId, "idle", "_failed"));
}

function bestEffortNotify(
  client: acp.AgentContext,
  params: { sessionId: string; update: acp.SessionUpdate },
): void {
  try {
    void client.notify(acp.methods.client.session.update, params).catch(() => {
      // Durable replay, not the socket, is the source of truth.
    });
  } catch {
    // A synchronously closed transport is repaired by replay as well.
  }
}

function notifyState(
  client: acp.AgentContext,
  sessionId: string,
  state: "running" | "idle",
  stopReason?: string,
): void {
  bestEffortNotify(client, {
    sessionId,
    update: {
      sessionUpdate: "state_update",
      state,
      ...(stopReason === undefined ? {} : { stopReason }),
    },
  });
}

function notifyIdle(client: acp.AgentContext, sessionId: string, result: ExecuteRunResult): void {
  notifyState(client, sessionId, "idle", stopReason(result.terminalClass));
}

function stopReason(terminalClass: TerminalClass): string {
  switch (terminalClass) {
    case "completed":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "_failed";
    case "unresolved":
      return "_unresolved";
  }
}

function toAcpUpdate(event: SessionEvent): acp.SessionUpdate {
  switch (event.kind) {
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
        ...(event.title === undefined ? {} : { title: event.title }),
        status: event.status,
        ...(event.content === undefined
          ? {}
          : {
              content: event.content.map((content) => ({
                type: "content" as const,
                content: content,
              })),
            }),
      };
    case "usage":
      return { sessionUpdate: "usage_update", used: event.used, size: event.size };
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
      (block.type === "resource" && capabilities.embeddedContext);
    if (!supported) {
      throw acp.RequestError.invalidParams(
        { contentType: block.type },
        `Prompt content type ${block.type} is not supported by this Agent`,
      );
    }
  }
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

async function mapError<T>(operation: () => Promise<T>): Promise<T> {
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
