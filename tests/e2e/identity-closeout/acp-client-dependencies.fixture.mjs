import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Repository tests use the exact locked service dependencies. Container clients
// resolve the same bare imports from the service image's normal node_modules.
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const mappings = Object.fromEntries(
  [
    "@agentclientprotocol/sdk",
    "@agentclientprotocol/sdk/experimental/v2",
    "@agentclientprotocol/sdk/experimental/ws-client",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ].map((name) => [name, pathToFileURL(require.resolve(name)).href]),
);
mappings.ws = new URL(
  "./wrapper.mjs",
  pathToFileURL(require.resolve("ws")),
).href;
registerHooks({
  resolve(specifier, context, next) {
    return mappings[specifier]
      ? { url: mappings[specifier], shortCircuit: true }
      : next(specifier, context);
  },
});
