import { requireNoClientMcpServers, runtimeToolCatalog } from "../../domain/mcp.js";
import { parseFileObservation } from "./file-observation.js";
import { runtimeCallStopped } from "./runtime-stop-evidence.js";
import type { RuntimeInformationPort } from "../../ports/runtime-information.js";
import { parseRuntimeInformation, RUNTIME_INFORMATION_URI } from "./runtime-information.js";
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
  annotations?: ToolDefinition["annotations"];
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
};

export interface McpConnection {
  readResource(uri: string, signal: AbortSignal): Promise<unknown>;
  listTools(signal: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(
    input: { name: string; arguments: { [key: string]: unknown } },
    signal: AbortSignal,
    onProgress?: ToolCallInput["onProgress"],
  ): Promise<{
    content: ContentBlock[];
    isError: boolean;
    structuredContent?: unknown;
    meta?: unknown;
  }>;
  close(): Promise<void>;
}

export interface McpDialer {
  connect(input: McpConnectInput): Promise<McpConnection>;
}

export type McpToolCatalogDependencies = {
  runtimeDialer: McpDialer;
  revisions: ClientMcpRevisionPort;
  reportConnectionCloseFailure?: (source: "runtime", sourceId: string, error: unknown) => void;
};

export class McpToolCallError extends Error {
  public readonly runtimeCallStopped: boolean;

  public constructor(
    message: string,
    public readonly effectState: ToolEffectState,
    options?: ErrorOptions & { runtimeCallStopped?: boolean },
  ) {
    super(message, options);
    this.name = "McpToolCallError";
    this.runtimeCallStopped = options?.runtimeCallStopped === true;
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
    const sources = await this.dependencies.revisions.getClientMcpRevision(
      snapshot.clientMcpRevisionId,
    );
    requireNoClientMcpServers(sources);
    return runtimeToolCatalog(await this.listRuntimeTools(snapshot, signal));
  }

  public async call(input: ToolCallInput): Promise<ToolCallResult> {
    if (input.tool.source !== "runtime") {
      throw new McpToolCallError("Client MCP injection is not supported", "none", {
        runtimeCallStopped: true,
      });
    }
    return this.callRuntime(input);
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
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          ...(tool.title === undefined ? {} : { title: tool.title }),
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

  private async invokeTool(
    dialer: McpDialer,
    connectInput: () => McpConnectInput,
    input: ToolCallInput,
    source: "runtime",
    reportCloseFailure: (error: unknown) => void,
  ): Promise<ToolCallResult> {
    let connection: McpConnection;
    try {
      input.signal.throwIfAborted();
      connection = await dialer.connect(connectInput());
    } catch (error) {
      throw new McpToolCallError("MCP Tool failed before dispatch", "none", {
        cause: error,
        runtimeCallStopped: true,
      });
    }

    try {
      if (input.signal.aborted)
        throw new McpToolCallError("MCP Tool cancelled before dispatch", "none", {
          runtimeCallStopped: true,
        });
      let result: Awaited<ReturnType<McpConnection["callTool"]>>;
      try {
        result = await connection.callTool(
          { name: input.tool.name, arguments: input.arguments },
          input.signal,
          input.onProgress,
        );
      } catch (error) {
        throw new McpToolCallError("MCP Tool outcome is unknown", "unknown", { cause: error });
      }
      const toolEffectState = receivedEffectState(result, source);
      const file = parseFileObservation(input.tool, { ...result, toolEffectState });
      return {
        runtimeCallStopped: runtimeCallStopped(input.tool.name, result),
        content: result.content,
        ...(file === undefined ? {} : { file }),
        isError: result.isError,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        toolEffectState,
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
  source: "runtime",
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
  source: "runtime",
): ToolEffectState | undefined {
  if (!isJsonObject(structuredContent)) {
    return undefined;
  }
  const state = structuredContent.effect_state;
  if (state !== "none" && state !== "settled" && state !== "unknown") {
    return undefined;
  }
  if (state === "unknown") {
    const expectedSource = `${source}_mcp`;
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
  const headers = { "x-antnest-expected-execution-id": executionId };
  if (new Headers(headers).get("x-antnest-expected-execution-id") !== executionId)
    throw new TypeError(
      "Runtime execution identity cannot be represented unchanged as an HTTP header",
    );
  return headers;
}
