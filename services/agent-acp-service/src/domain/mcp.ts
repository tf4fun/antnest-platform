import { DomainError } from "./errors.js";
import type { ModelToolDefinition, ToolDefinition } from "./types.js";

export type ClientMcpInput =
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Array<{ name: string; value: string }>;
    }
  | {
      type: string;
      name: string;
      [key: string]: unknown;
    };

export type NormalizedClientMcpSource = {
  sourceId: string;
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

export function requireNoClientMcpServers(inputs: readonly unknown[]): [] {
  if (inputs.length > 0) {
    throw new DomainError(
      "client_mcp_not_allowed",
      "Client MCP injection is not supported; load/resume with mcpServers: [] and use platform Runtime tools",
    );
  }
  return [];
}

export function runtimeToolCatalog(tools: readonly ToolDefinition[]): ModelToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (tool.source !== "runtime") {
      throw new DomainError("client_mcp_not_allowed", "Only platform Runtime tools are supported");
    }
    if (names.has(tool.name)) {
      throw new DomainError("tool_name_collision", `Tool name collision for ${tool.name}`);
    }
    names.add(tool.name);
    return { ...tool, modelName: tool.name };
  });
}
