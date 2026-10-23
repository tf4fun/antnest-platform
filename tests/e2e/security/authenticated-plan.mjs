import assert from "node:assert/strict";
import { join } from "node:path";

export function authenticatedPlan({ config, topology, agentId, mode }) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.match(agentId, /^agent_[a-f0-9]{32}$/u);
  assert(["admission", "policy-off"].includes(mode));
  const profiles =
    config.ownerProfiles === undefined ? [] : config.ownerProfiles;
  assert(Array.isArray(profiles));
  assert(
    profiles.length <= 1 &&
      profiles.every((profile) => profile === "acp-owner-bootstrap"),
  );
  const owner =
    mode === "admission" && profiles.includes("acp-owner-bootstrap");
  const prefix = config.env.ANTNEST_SERVICE_NETWORK_PREFIX;
  assert.match(prefix, /^10\.244\.(?:[1-9]\d?|1\d\d|200)$/u);
  const pairs = {
    "gateway-identity": ["edge-gateway", "identity-service"],
    "acp-controller": ["agent-acp-service", "agent-controller"],
    "console-controller": ["admin-console", "agent-controller"],
    ...(owner ? { "rc-acp": ["runtime-controller", "agent-acp-service"] } : {}),
    ...(mode === "admission"
      ? {
          "console-identity": ["admin-console", "identity-service"],
          "agent-ui-acp": ["agent-ui", "agent-acp-service"],
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
    ...(owner ? [["owner", "agent-acp-service", "owner"]] : []),
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
