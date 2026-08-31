import { createHash } from "node:crypto";

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

export function normalizeClientMcpServers(
  inputs: readonly ClientMcpInput[],
): NormalizedClientMcpSource[] {
  const names = new Set<string>();
  return inputs.map((input) => {
    if (input.type !== "http" || !("url" in input) || typeof input.url !== "string") {
      throw new DomainError("unsupported_mcp_transport", "Only HTTP client MCP is supported");
    }
    const name = normalizeName(input.name);
    if (names.has(name)) {
      throw new DomainError("duplicate_mcp_source", `Duplicate client MCP source ${name}`);
    }
    names.add(name);

    const url = normalizeUrl(input.url);
    const headers = normalizeHeaders(readHeaders(input));
    return {
      sourceId: digest(`${name}\n${url}`),
      name,
      url,
      headers,
    };
  });
}

export function qualifyClientToolName(sourceId: string, toolName: string): string {
  const readable = toolName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
  const base = readable.length > 0 ? readable : "tool";
  return `client_${base}_${digest(`${sourceId}\n${toolName}`).slice(0, 8)}`;
}

export function mergeToolCatalogs(
  runtimeTools: readonly ToolDefinition[],
  clientTools: readonly ToolDefinition[],
): ModelToolDefinition[] {
  const result: ModelToolDefinition[] = runtimeTools.map((tool) => ({
    ...tool,
    source: "runtime",
    modelName: tool.name,
  }));

  for (const tool of clientTools) {
    result.push({
      ...tool,
      source: "client",
      modelName: qualifyClientToolName(tool.sourceId, tool.name),
    });
  }

  const names = new Set<string>();
  for (const tool of result) {
    if (names.has(tool.modelName)) {
      throw new DomainError("tool_name_collision", `Tool name collision for ${tool.modelName}`);
    }
    names.add(tool.modelName);
  }
  return result;
}

function normalizeName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainError("invalid_mcp_source", "Client MCP name is required");
  }
  return normalized;
}

function readHeaders(
  input: ClientMcpInput,
): readonly { name: string; value: string }[] | undefined {
  if (!("headers" in input) || input.headers === undefined) {
    return undefined;
  }
  if (!Array.isArray(input.headers) || !input.headers.every(isHeader)) {
    throw new DomainError("invalid_mcp_header", "Client MCP headers are invalid");
  }
  return input.headers;
}

function isHeader(value: unknown): value is { name: string; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "value" in value &&
    typeof value.value === "string"
  );
}

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("invalid_mcp_source", "Client MCP URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new DomainError("unsupported_mcp_transport", "Client MCP endpoints must use HTTPS");
  }
  url.hash = "";
  return url.toString();
}

function normalizeHeaders(
  headers: readonly { name: string; value: string }[] | undefined,
): Array<{ name: string; value: string }> {
  if (headers === undefined) {
    return [];
  }
  const names = new Set<string>();
  return headers.map((header) => {
    const name = header.name.trim().toLowerCase();
    if (name.length === 0 || names.has(name)) {
      throw new DomainError("invalid_mcp_header", "Client MCP header names must be unique");
    }
    names.add(name);
    return { name, value: header.value };
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
