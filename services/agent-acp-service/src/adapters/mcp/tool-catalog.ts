import { mergeToolCatalogs } from "../../domain/mcp.js";
import type { RuntimeInformationPort } from "../../ports/runtime-information.js";
import { parseRuntimeInformation, RUNTIME_INFORMATION_URI } from "./runtime-information.js";
import { context, propagation } from "@opentelemetry/api";
import type {
  ContentBlock,
  JsonObject,
  ModelToolDefinition,
  ToolEffectState,
  ToolDefinition,
} from "../../domain/types.js";
import type {
  ClientMcpRevisionPort,
  ToolCallInput,
  ToolCallResult,
  ToolCatalogPort,
} from "../../ports/tools.js";

export type McpConnectInput = {
  endpoint: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
};

export type McpRemoteTool = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

export interface McpConnection {
  readResource(uri: string, signal: AbortSignal): Promise<unknown>;
  listTools(signal: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(
    input: { name: string; arguments: { [key: string]: unknown } },
    signal: AbortSignal,
  ): Promise<{ content: ContentBlock[]; isError: boolean; structuredContent?: unknown }>;
  close(): Promise<void>;
}

export interface McpDialer {
  connect(input: McpConnectInput): Promise<McpConnection>;
}

export type McpToolCatalogDependencies = {
  runtimeDialer: McpDialer;
  clientDialer: McpDialer;
  revisions: ClientMcpRevisionPort;
  reportClientSourceFailure?: (sourceId: string, error: unknown) => void;
  reportConnectionCloseFailure?: (
    source: "runtime" | "client",
    sourceId: string,
    error: unknown,
  ) => void;
};

export class McpToolCallError extends Error {
  public constructor(
    message: string,
    public readonly effectState: ToolEffectState,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpToolCallError";
  }
}

export class McpToolCatalog implements ToolCatalogPort, RuntimeInformationPort {
  public constructor(private readonly dependencies: McpToolCatalogDependencies) {}

  public async read(snapshot: ToolCallInput["snapshot"], signal: AbortSignal) {
    return this.withConnection(
      this.dependencies.runtimeDialer,
      {
        endpoint: new URL(snapshot.runtime.mcpEndpoint),
        headers: runtimeHeaders(snapshot.runtime.executionId),
        signal,
      },
      (error) => this.dependencies.reportConnectionCloseFailure?.("runtime", "runtime", error),
      async (connection) =>
        parseRuntimeInformation(
          await connection.readResource(RUNTIME_INFORMATION_URI, signal),
          snapshot.runtime.executionId,
        ),
    );
  }

  public async list(
    snapshot: ToolCallInput["snapshot"],
    signal: AbortSignal,
  ): Promise<ModelToolDefinition[]> {
    const runtime = await this.listRuntimeTools(snapshot, signal);
    const sources = await this.dependencies.revisions.getClientMcpRevision(
      snapshot.clientMcpRevisionId,
    );
    const clients: ToolDefinition[] = [];
    for (const source of sources) {
      try {
        clients.push(...(await this.listClientTools(source, signal)));
      } catch (error) {
        signal.throwIfAborted();
        this.dependencies.reportClientSourceFailure?.(source.sourceId, error);
      }
    }
    return mergeToolCatalogs(runtime, clients);
  }

  public async call(input: ToolCallInput): Promise<ToolCallResult> {
    if (input.tool.source === "runtime") {
      return this.callRuntime(input);
    }
    return this.callClient(input);
  }

  private async listRuntimeTools(
    snapshot: ToolCallInput["snapshot"],
    signal: AbortSignal,
  ): Promise<ToolDefinition[]> {
    return this.withConnection(
      this.dependencies.runtimeDialer,
      {
        endpoint: new URL(snapshot.runtime.mcpEndpoint),
        headers: runtimeHeaders(snapshot.runtime.executionId),
        signal,
      },
      (error) => this.dependencies.reportConnectionCloseFailure?.("runtime", "runtime", error),
      async (connection) =>
        (await connection.listTools(signal)).map((tool) => ({
          source: "runtime",
          sourceId: "runtime",
          name: tool.name,
          description: tool.description ?? "",
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        })),
    );
  }

  private async listClientTools(
    source: Awaited<ReturnType<ClientMcpRevisionPort["getClientMcpRevision"]>>[number],
    signal: AbortSignal,
  ): Promise<ToolDefinition[]> {
    return this.withConnection(
      this.dependencies.clientDialer,
      {
        endpoint: new URL(source.url),
        headers: tracedHeaders(
          Object.fromEntries(source.headers.map((header) => [header.name, header.value])),
        ),
        signal,
      },
      (error) => this.dependencies.reportConnectionCloseFailure?.("client", source.sourceId, error),
      async (connection) =>
        (await connection.listTools(signal)).map((tool) => ({
          source: "client",
          sourceId: source.sourceId,
          name: tool.name,
          description: tool.description ?? "",
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        })),
    );
  }

  private async callRuntime(input: ToolCallInput): Promise<ToolCallResult> {
    return this.invokeTool(
      this.dependencies.runtimeDialer,
      () => ({
        endpoint: new URL(input.snapshot.runtime.mcpEndpoint),
        headers: runtimeHeaders(input.snapshot.runtime.executionId),
        signal: input.signal,
      }),
      input,
      "runtime",
      (error) => this.dependencies.reportConnectionCloseFailure?.("runtime", "runtime", error),
    );
  }

  private async callClient(input: ToolCallInput): Promise<ToolCallResult> {
    const sources = await this.dependencies.revisions.getClientMcpRevision(
      input.snapshot.clientMcpRevisionId,
    );
    const source = sources.find((candidate) => candidate.sourceId === input.tool.sourceId);
    if (source === undefined) {
      throw new McpToolCallError("Client MCP source is not part of this Run", "none");
    }
    return this.invokeTool(
      this.dependencies.clientDialer,
      () => ({
        endpoint: new URL(source.url),
        headers: tracedHeaders(
          Object.fromEntries(source.headers.map((header) => [header.name, header.value])),
        ),
        signal: input.signal,
      }),
      input,
      "client",
      (error) => this.dependencies.reportConnectionCloseFailure?.("client", source.sourceId, error),
    );
  }

  private async invokeTool(
    dialer: McpDialer,
    connectInput: () => McpConnectInput,
    input: ToolCallInput,
    source: "runtime" | "client",
    reportCloseFailure: (error: unknown) => void,
  ): Promise<ToolCallResult> {
    let connection: McpConnection;
    try {
      connection = await dialer.connect(connectInput());
    } catch (error) {
      throw new McpToolCallError("MCP Tool failed before dispatch", "none", { cause: error });
    }

    try {
      let result: Awaited<ReturnType<McpConnection["callTool"]>>;
      try {
        result = await connection.callTool(
          { name: input.tool.name, arguments: input.arguments },
          input.signal,
        );
      } catch (error) {
        throw new McpToolCallError("MCP Tool outcome is unknown", "unknown", { cause: error });
      }
      return {
        content: result.content,
        isError: result.isError,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        toolEffectState: receivedEffectState(result, source),
      };
    } finally {
      try {
        await connection.close();
      } catch (error) {
        reportCloseFailure(error);
      }
    }
  }

  private async withConnection<Result>(
    dialer: McpDialer,
    input: McpConnectInput,
    reportCloseFailure: (error: unknown) => void,
    operation: (connection: McpConnection) => Promise<Result>,
  ): Promise<Result> {
    const connection = await dialer.connect(input);
    try {
      return await operation(connection);
    } finally {
      try {
        await connection.close();
      } catch (error) {
        reportCloseFailure(error);
      }
    }
  }
}

function receivedEffectState(
  result: Awaited<ReturnType<McpConnection["callTool"]>>,
  source: "runtime" | "client",
): ToolEffectState {
  if (isJsonObject(result.structuredContent) && result.structuredContent.effect_state === "unknown")
    return "unknown";
  if (!result.isError) {
    return declaredEffectState(result.structuredContent, source) === "unknown"
      ? "unknown"
      : "settled";
  }
  return declaredEffectState(result.structuredContent, source) ?? "settled";
}

function declaredEffectState(
  structuredContent: unknown,
  source: "runtime" | "client",
): ToolEffectState | undefined {
  if (!isJsonObject(structuredContent)) {
    return undefined;
  }
  const state = structuredContent.effect_state;
  if (state !== "none" && state !== "settled" && state !== "unknown") {
    return undefined;
  }
  if (state === "unknown") {
    const expectedSource = source === "runtime" ? "runtime_mcp" : "client_mcp";
    return structuredContent.effect_source === expectedSource ? state : undefined;
  }
  return structuredContent.effect_source === null || structuredContent.effect_source === undefined
    ? state
    : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeHeaders(executionId: string): Record<string, string> {
  return tracedHeaders({ "x-antnest-expected-execution-id": executionId });
}

function tracedHeaders(headers: Record<string, string>): Record<string, string> {
  const traced = { ...headers };
  propagation.inject(context.active(), traced);
  return traced;
}
