import { existsSync } from "node:fs";
import { afterEach, expect } from "vitest";
import { RuntimeConnections } from "../../src/adapters/runtime-connections.js";

const owned = new Set<RuntimeConnections>();

/** Real sender storage with explicit test ownership; no anonymous Runtime fallback. */
export function runtimeConnections() {
  const connections = new RuntimeConnections({
    authMode: "token",
    allowInsecureTransport: "true",
  });
  owned.add(connections);
  return connections;
}

afterEach(async () => {
  for (const connections of owned) {
    await connections.close();
    expect(existsSync(connections.directory)).toBe(false);
  }
  owned.clear();
});
