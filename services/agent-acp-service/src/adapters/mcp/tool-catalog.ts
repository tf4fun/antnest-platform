import { mergeToolCatalogs } from "../../domain/mcp.js";
import { context, propagation } from "@opentelemetry/api";
import type {
  ContentBlock,
  JsonValue,
  ModelToolDefinition,
  RuntimeEffectState,
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
  inputSchema?: JsonValue;
};

export interface McpConnection {
  listTools(signal: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(
    input: { name: string; arguments: { [key: string]: unknown } },
    signal: AbortSignal,
  ): Promise<{ content: ContentBlock[]; isError: boolean }>;
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
};

export class McpToolCallError extends Error {
  public constructor(
    message: string,
    public readonly effectState: RuntimeEffectState,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpToolCallError";
  }
}

export class McpToolCatalog implements ToolCatalogPort {
  public constructor(private readonly dependencies: McpToolCatalogDependencies) {}

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
    try {
      const result = await this.withConnection(
        this.dependencies.runtimeDialer,
        {
          endpoint: new URL(input.snapshot.runtime.mcpEndpoint),
          headers: runtimeHeaders(input.snapshot.runtime.executionId),
          signal: input.signal,
        },
        async (connection) =>
          connection.callTool({ name: input.tool.name, arguments: input.arguments }, input.signal),
      );
      return { ...result, runtimeEffectState: "settled" };
    } catch (error) {
      throw new McpToolCallError("Runtime Tool outcome is unknown", "unknown", { cause: error });
    }
  }

  private async callClient(input: ToolCallInput): Promise<ToolCallResult> {
    const sources = await this.dependencies.revisions.getClientMcpRevision(
      input.snapshot.clientMcpRevisionId,
    );
    const source = sources.find((candidate) => candidate.sourceId === input.tool.sourceId);
    if (source === undefined) {
      throw new McpToolCallError("Client MCP source is not part of this Run", "none");
    }
    try {
      const result = await this.withConnection(
        this.dependencies.clientDialer,
        {
          endpoint: new URL(source.url),
          headers: tracedHeaders(
            Object.fromEntries(source.headers.map((header) => [header.name, header.value])),
          ),
          signal: input.signal,
        },
        async (connection) =>
          connection.callTool({ name: input.tool.name, arguments: input.arguments }, input.signal),
      );
      return { ...result, runtimeEffectState: "none" };
    } catch (error) {
      throw new McpToolCallError("Client MCP source did not produce a result", "none", {
        cause: error,
      });
    }
  }

  private async withConnection<Result>(
    dialer: McpDialer,
    input: McpConnectInput,
    operation: (connection: McpConnection) => Promise<Result>,
  ): Promise<Result> {
    const connection = await dialer.connect(input);
    try {
      return await operation(connection);
    } finally {
      await connection.close();
    }
  }
}

function runtimeHeaders(executionId: string): Record<string, string> {
  return tracedHeaders({ "x-antnest-expected-execution-id": executionId });
}

function tracedHeaders(headers: Record<string, string>): Record<string, string> {
  const traced = { ...headers };
  propagation.inject(context.active(), traced);
  return traced;
}
