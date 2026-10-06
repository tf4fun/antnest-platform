import { registerHooks } from "node:module";

// Use the owning service's locked dependencies and native import conditions.
const dependencyRoot = new URL(
  "../../../services/agent-acp-service/package.json",
  import.meta.url,
).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "ws" ||
      specifier === "@agentclientprotocol/sdk" ||
      specifier.startsWith("@agentclientprotocol/sdk/")
    ) {
      return nextResolve(specifier, { ...context, parentURL: dependencyRoot });
    }
    return nextResolve(specifier, context);
  },
});
try {
  await import("./client.mjs");
} finally {
  hook.deregister();
}
