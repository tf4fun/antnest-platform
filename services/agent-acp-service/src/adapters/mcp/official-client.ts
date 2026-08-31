import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";

import type { ContentBlock, JsonValue } from "../../domain/types.js";
import {
  ClientMcpNetworkPolicy,
  createClientMcpFetch,
  type ManagedFetch,
} from "./client-network.js";
import type { McpConnectInput, McpConnection, McpDialer, McpRemoteTool } from "./tool-catalog.js";

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
      ...(managedFetch === undefined ? {} : { fetch: managedFetch.fetch }),
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

  public async listTools(signal: AbortSignal): Promise<McpRemoteTool[]> {
    const result = await this.client.listTools(undefined, { signal, cacheMode: "refresh" });
    return result.tools.map(toRemoteTool);
  }

  public async callTool(
    input: { name: string; arguments: { [key: string]: unknown } },
    signal: AbortSignal,
  ): Promise<{ content: ContentBlock[]; isError: boolean }> {
    const result = await this.client.callTool(input, { signal });
    return {
      content: result.content.map((block) => structuredClone(block) as ContentBlock),
      isError: result.isError ?? false,
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
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema) as JsonValue,
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
