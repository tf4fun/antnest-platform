import { fileURLToPath } from "node:url";

export const serviceRoot = fileURLToPath(new URL(".", import.meta.url));
export const integrationRoot = fileURLToPath(
  new URL("../../tests/integration/agent-acp-service", import.meta.url),
);

// Resolve the root tests against this service's existing, locked installation.
// Exact matches preserve SDK subpath exports and their ESM import conditions.
const modules = [
  "@agentclientprotocol/sdk",
  "@agentclientprotocol/sdk/experimental/http-client",
  "@agentclientprotocol/sdk/experimental/server",
  "@agentclientprotocol/sdk/experimental/node",
  "@agentclientprotocol/sdk/experimental/v2",
  "@agentclientprotocol/sdk/experimental/ws-client",
  "@agentclientprotocol/sdk/schema/schema.json",
  "@agentclientprotocol/sdk/schema/v2/schema.unstable.json",
  "@modelcontextprotocol/server",
  "@opentelemetry/api",
  "@opentelemetry/sdk-node",
  "ajv",
  "ajv/dist/2020.js",
  "diff",
  "eventsource-parser",
  "pg",
  "vitest",
  "ws",
  "zod",
];

export const integrationAlias = modules.map((name) => ({
  find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  replacement: fileURLToPath(import.meta.resolve(name)),
}));
