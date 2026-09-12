import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type Progress,
} from "@modelcontextprotocol/client";

import type { ContentBlock, JsonObject } from "../../domain/types.js";
import type { ToolCallInput } from "../../ports/tools.js";
import {
  ClientMcpNetworkPolicy,
  createClientMcpFetch,
  type ManagedFetch,
} from "./client-network.js";
import type { McpConnectInput, McpConnection, McpDialer, McpRemoteTool } from "./tool-catalog.js";
import { tracedFetch } from "../../telemetry/http.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";

export type OfficialMcpDialerOptions =
  | { trust: "runtime" }
  | {
      trust: "client";
      blockedCidrs?: string[];
    };

export class OfficialMcpDialer implements McpDialer {
  public constructor(private readonly options: OfficialMcpDialerOptions) {}

  public async connect(input: McpConnectInput): Promise<McpConnection> {
    const managedFetch = this.clientFetch(input);
    const client = new Client(
      { name: "antnest-agent-acp-service", version: "0.1.0" },
      {
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
      },
    );
    const transport = new StreamableHTTPClientTransport(input.endpoint, {
      requestInit: { headers: input.headers },
      fetch:
        managedFetch?.fetch ??
        ((url, init = {}) => tracedFetch(fetch, "antnest-runtime")(url, init)),
      reconnectionOptions: {
        maxReconnectionDelay: 1_000,
        initialReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
      onInsufficientScope: "throw",
    });

    try {
      await client.connect(transport, { signal: input.signal });
      return new OfficialMcpConnection(client, managedFetch);
    } catch (error) {
      await closeAfterFailure(client, managedFetch);
      throw error;
    }
  }

  private clientFetch(input: McpConnectInput): ManagedFetch | undefined {
    if (this.options.trust === "runtime") {
      return undefined;
    }
    const policy = new ClientMcpNetworkPolicy({
      ...(this.options.blockedCidrs === undefined
        ? {}
        : { blockedCidrs: this.options.blockedCidrs }),
    });
    return createClientMcpFetch({
      policy,
      sensitiveHeaders: Object.keys(input.headers),
    });
  }
}

class OfficialMcpConnection implements McpConnection {
  public constructor(
    private readonly client: Client,
    private readonly managedFetch: ManagedFetch | undefined,
  ) {}

  public readResource(uri: string, signal: AbortSignal): Promise<unknown> {
    return this.client.readResource({ uri }, { signal, cacheMode: "refresh" });
  }

  public async listTools(signal: AbortSignal): Promise<McpRemoteTool[]> {
    const result = await this.client.listTools(undefined, { signal, cacheMode: "refresh" });
    return result.tools.map(toRemoteTool);
  }

  public async callTool(
    input: { name: string; arguments: { [key: string]: unknown } },
    signal: AbortSignal,
    onProgress?: ToolCallInput["onProgress"],
  ): Promise<{
    content: ContentBlock[];
    isError: boolean;
    structuredContent?: unknown;
    meta?: unknown;
  }> {
    const result = await this.client.callTool(input, {
      signal,
      ...(onProgress === undefined
        ? {}
        : {
            onprogress: (update: Progress) =>
              onProgress({
                progress: update.progress,
                ...(update.total === undefined ? {} : { total: update.total }),
                ...(update.message === undefined ? {} : { message: update.message }),
              }),
          }),
    });
    return {
      content: result.content.map((block) => structuredClone(block) as ContentBlock),
      ...(result._meta === undefined ? {} : { meta: result._meta }),
      isError: result.isError ?? false,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: structuredClone(result.structuredContent) }),
    };
  }

  public async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.managedFetch?.close();
    }
  }
}

function toRemoteTool(tool: Tool): McpRemoteTool {
  return {
    name: tool.name,
    ...(tool.annotations === undefined
      ? {}
      : {
          annotations: {
            ...(tool.annotations.readOnlyHint === undefined
              ? {}
              : { readOnlyHint: tool.annotations.readOnlyHint }),
            ...(tool.annotations.destructiveHint === undefined
              ? {}
              : { destructiveHint: tool.annotations.destructiveHint }),
          },
        }),
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema) as JsonObject,
  };
}

async function closeAfterFailure(
  client: Client,
  managedFetch: ManagedFetch | undefined,
): Promise<void> {
  try {
    await client.close();
  } catch {
    // Connection setup never completed; no protocol state can be recovered here.
  } finally {
    await managedFetch?.close();
  }
}
