import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  workspaceFromBootstrap,
  workspaceFromBridgeBootstrap,
} from "./bootstrap.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../../../contracts/common/id-vectors.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { accept: string[]; reject: string[] }>;

const baseAgents = [
  {
    agent_id: "agent-1",
    name: "Agent",
    lifecycle_state: "not_created",
    runtime_state: "absent",
  },
];

const bridgeAgents = [
  {
    agentId: "agent-1",
    name: "Agent",
    lifecycle: "not_created",
    runtime: "absent",
  },
];

const legacyPayload = (field: string, value: string) => {
  const principal = {
    user_id: field === "principal.user_id" ? value : "user-1",
    organization_id: field === "principal.organization_id" ? value : "org-1",
    organization_slug: "engineering",
    organization_name: "Engineering",
    administrator: false,
  };
  const agents = field === "agent.agent_id" ? [{ ...baseAgents[0], agent_id: value }] : baseAgents;
  return { principal, agents };
};

const bridgePayload = (field: string, value: string) => {
  const principal = {
    userId: field === "principal.user_id" ? value : "user-1",
    organizationId: field === "principal.organization_id" ? value : "org-1",
    organizationSlug: "engineering",
    organizationName: "Engineering",
    administrator: false,
  };
  const agents = field === "agent.agent_id" ? [{ ...bridgeAgents[0], agentId: value }] : bridgeAgents;
  return { principal, agents, renderedAt: "2026-10-02T00:00:00Z", bridgeEpoch: "epoch" };
};

const cases = [
  { kind: "userId", field: "principal.user_id", out: (w: ReturnType<typeof workspaceFromBootstrap>) => w.principal.userId },
  { kind: "organizationId", field: "principal.organization_id", out: (w: ReturnType<typeof workspaceFromBootstrap>) => w.principal.organizationId },
  { kind: "agentId", field: "agent.agent_id", out: (w: ReturnType<typeof workspaceFromBootstrap>) => w.agents[0]?.id },
];

test("workspace bootstrap keeps shared opaque IDs verbatim", () => {
  for (const { kind, field, out } of cases) {
    for (const value of vectors[kind].accept) {
      const legacy = workspaceFromBootstrap(legacyPayload(field, value));
      assert.strictEqual(out(legacy), value, `legacy ${field} must keep ${JSON.stringify(value)}`);
      const bridge = workspaceFromBridgeBootstrap(bridgePayload(field, value));
      assert.strictEqual(out(bridge), value, `bridge ${field} must keep ${JSON.stringify(value)}`);
      assert.strictEqual(legacy.principal.organizationName, "Engineering");
      assert.strictEqual(legacy.principal.organizationSlug, "engineering");
    }
    for (const value of vectors[kind].reject) {
      assert.throws(() => workspaceFromBootstrap(legacyPayload(field, value)), `legacy ${field} must reject ${JSON.stringify(value)}`);
      assert.throws(() => workspaceFromBridgeBootstrap(bridgePayload(field, value)), `bridge ${field} must reject ${JSON.stringify(value)}`);
    }
  }
});
