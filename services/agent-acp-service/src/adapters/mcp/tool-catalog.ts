import { requireNoClientMcpServers, runtimeToolCatalog } from "../../domain/mcp.js";
import { parseFileObservation } from "./file-observation.js";
import { runtimeCallStopped } from "./runtime-stop-evidence.js";
import type { RuntimePath } from "../../domain/runtime-information.js";
import type { RuntimeInformationPort } from "../../ports/runtime-information.js";
import { parseRuntimeInformation, RUNTIME_INFORMATION_URI } from "./runtime-information.js";
import type {
  ContentBlock,
  JsonObject,
  ModelToolDefinition,
  ToolEffectState,
  ToolDefinition,
  RuntimeBinding,
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
  runtimeBinding?: RuntimeBinding;
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
    return this.readBinding(snapshot.runtime, signal);
  }

  /** Reads the current Runtime binding for maintenance admission, not a historical Run snapshot. */
  public async readBinding(binding: RuntimeBinding, signal: AbortSignal) {
    return this.withConnection(
      this.dependencies.runtimeDialer,
      {
        endpoint: new URL(binding.mcpEndpoint),
        runtimeBinding: binding,
        headers: runtimeHeaders(binding.executionId),
        signal,
      },
      (error) => this.dependencies.reportConnectionCloseFailure?.("runtime", "runtime", error),
      async (connection) =>
        parseRuntimeInformation(
          await connection.readResource(RUNTIME_INFORMATION_URI, signal),
          binding.executionId,
        ),
    );
  }

  /** Reads only an explicitly named personal Skill; no model tool catalog is exposed. */
  public async readPersonalSkill(
    binding: RuntimeBinding,
    packagePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!/^\.antnest\/skills\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(packagePath))
      throw new Error("Learning Skill path is invalid");
    return this.readSkillFile(binding, `${packagePath}/SKILL.md`, signal);
  }

  public async readSkill(
    binding: RuntimeBinding,
    path: RuntimePath,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      !path.path.endsWith("/SKILL.md") ||
      path.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[\\\p{Cc}]/u.test(path.path)
    )
      throw new Error("Skill path is invalid");
    return this.readSkillFile(
      binding,
      `${path.root === "system_skills" ? "/skills" : "/workspace"}/${path.path}`,
      signal,
    );
  }

  private async readSkillFile(
    binding: RuntimeBinding,
    path: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.withConnection(
      this.dependencies.runtimeDialer,
      {
        endpoint: new URL(binding.mcpEndpoint),
        runtimeBinding: binding,
        headers: runtimeHeaders(binding.executionId),
        signal,
      },
      (error) => this.dependencies.reportConnectionCloseFailure?.("runtime", "runtime", error),
      async (connection) => {
        const reply = await connection.callTool(
          {
            name: "read",
            arguments: {
              path,
              offset: 1,
              limit: 16_385,
            },
          },
          signal,
        );
        const value = reply.structuredContent;
        if (
          reply.isError ||
          typeof value !== "object" ||
          value === null ||
          !("content" in value) ||
          typeof value.content !== "string" ||
          !("truncated" in value) ||
          value.truncated !== false ||
          !("effect_state" in value) ||
          value.effect_state !== "settled" ||
          Buffer.byteLength(value.content, "utf8") > 16_384
        )
          throw new Error("Skill read is incomplete (maximum 16 KiB)");
        return value.content;
      },
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
        runtimeBinding: snapshot.runtime,
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
        runtimeBinding: input.snapshot.runtime,
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
