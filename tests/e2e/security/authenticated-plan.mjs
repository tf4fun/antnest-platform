import assert from "node:assert/strict";
import { join } from "node:path";

export function authenticatedPlan({ config, topology, agentId, mode }) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.match(agentId, /^agent_[a-f0-9]{32}$/u);
  assert(["admission", "policy-off"].includes(mode));
  const prefix = config.env.ANTNEST_SERVICE_NETWORK_PREFIX;
  assert.match(prefix, /^10\.244\.(?:[1-9]\d?|1\d\d|200)$/u);
  const pairs = {
    "gateway-identity": ["edge-gateway", "identity-service"],
    "acp-controller": ["agent-acp-service", "agent-controller"],
    "console-controller": ["admin-console", "agent-controller"],
    ...(mode === "admission"
      ? {
          "console-identity": ["admin-console", "identity-service"],
          "gateway-acp": ["edge-gateway", "agent-acp-service"],
          "acp-registry": ["agent-acp-service", "skill-registry"],
          "rc-registry": ["runtime-controller", "skill-registry"],
        }
      : {}),
  };
  const networks = new Set();
  const endpoints = {};
  for (const [key, service, name] of [
    ["identity", "identity-service", "primary"],
    ["controller", "agent-controller", "primary"],
    ...(mode === "admission"
      ? [
          ["workspace", "agent-acp-service", "primary"],
          ["control", "agent-acp-service", "control"],
          ["registry", "skill-registry", "primary"],
        ]
      : []),
  ]) {
    const listener = topology.listeners[service][name];
    networks.add(`${config.project}_${listener.network}`);
    endpoints[key] =
      `http://${prefix}.${listener.address_suffix}:${listener.port}`;
  }
  const mounts = Object.entries(pairs).map(([name, [sender, receiver]]) => ({
    source: join(config.credentials, sender, "tokens", receiver),
    destination: `/run/auth/${name}`,
  }));
  return {
    mode,
    agent_id: agentId,
    endpoints,
    networks: [...networks],
    mounts,
  };
}
