import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authenticatedPlan } from "./authenticated-plan.mjs";

const topology = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-network-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixture = () => ({
  config: {
    project: "antnest-lifecycle-1234abcd",
    credentials: "/private/disposable-credentials",
    env: { ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.45" },
  },
  topology,
  agentId: `agent_${"1".repeat(32)}`,
});

test("policy setup uses separate ACP/Console/Gateway grants and only their purpose listeners", () => {
  const plan = authenticatedPlan({ ...fixture(), mode: "policy-off" });
  assert.equal(plan.endpoints.identity, "http://10.244.45.66:8080");
  assert.equal(plan.endpoints.controller, "http://10.244.45.18:8080");
  assert.equal(plan.mounts.length, 3);
  assert(plan.mounts.every((mount) => mount.source.includes("/tokens/")));
  assert(plan.mounts.every((mount) => !mount.source.endsWith("tokens")));
  assert.deepEqual(
    new Set(plan.networks),
    new Set([
      "antnest-lifecycle-1234abcd_identity-clients",
      "antnest-lifecycle-1234abcd_controller-clients",
    ]),
  );
});

test("signed-context admission preserves the distinct control address and exact receiver files", () => {
  const plan = authenticatedPlan({ ...fixture(), mode: "admission" });
  assert.equal(plan.endpoints.control, "http://10.244.45.34:8081");
  assert.equal(plan.endpoints.workspace, "http://10.244.45.5:8080");
  assert(plan.networks.includes("antnest-lifecycle-1234abcd_edge"));
  assert.deepEqual(
    plan.mounts.find((mount) => mount.destination === "/run/auth/agent-ui-acp"),
    {
      source:
        "/private/disposable-credentials/agent-ui/tokens/agent-acp-service",
      destination: "/run/auth/agent-ui-acp",
    },
  );
  assert(
    !plan.mounts.some((mount) =>
      mount.source.endsWith("edge-gateway/tokens/agent-acp-service"),
    ),
  );
  assert(plan.networks.includes("antnest-lifecycle-1234abcd_controller-acp"));
  assert(
    plan.mounts.some(
      (mount) =>
        mount.source.endsWith("runtime-controller/tokens/skill-registry") &&
        mount.destination.endsWith("rc-registry"),
    ),
  );
  assert.equal(plan.mounts.length, 7);
});

test("authenticated peers reject unknown modes, retained scopes and nonfixture subnets", () => {
  for (const mutate of [
    (input) => {
      input.mode = "unrestricted";
    },
    (input) => {
      input.config.project = "human-deployment";
    },
    (input) => {
      input.config.env.ANTNEST_SERVICE_NETWORK_PREFIX = "10.241.0";
    },
    (input) => {
      input.agentId = "unknown";
    },
  ]) {
    const input = { ...fixture(), mode: "admission" };
    mutate(input);
    assert.throws(() => authenticatedPlan(input));
  }
});

test("owner admission mounts the exact RC grant only for the explicit owner profile", () => {
  const input = fixture();
  input.config.ownerProfiles = ["acp-owner-bootstrap"];
  const plan = authenticatedPlan({ ...input, mode: "admission" });
  assert.equal(plan.endpoints.owner, "http://10.244.45.53:8085");
  assert(
    plan.networks.includes("antnest-lifecycle-1234abcd_controller-runtime"),
  );
  assert.deepEqual(
    plan.mounts.find((m) => m.destination === "/run/auth/rc-acp"),
    {
      source:
        "/private/disposable-credentials/runtime-controller/tokens/agent-acp-service",
      destination: "/run/auth/rc-acp",
    },
  );
  assert.equal(plan.mounts.length, 8);
  for (const mode of ["admission", "policy-off"]) {
    const ordinary = authenticatedPlan({ ...fixture(), mode });
    assert.equal(ordinary.endpoints.owner, undefined);
    assert(!ordinary.mounts.some((m) => m.destination === "/run/auth/rc-acp"));
  }
  const policy = authenticatedPlan({ ...input, mode: "policy-off" });
  assert.equal(policy.endpoints.owner, undefined);
  assert(!policy.mounts.some((m) => m.destination === "/run/auth/rc-acp"));
});

test("owner admission rejects a misspelled or malformed profile", () => {
  for (const profiles of [
    ["acp-owner-bootstrp"],
    ["acp-owner-bootstrap", "unknown"],
    "acp-owner-bootstrap",
    null,
  ]) {
    const input = fixture();
    input.config.ownerProfiles = profiles;
    assert.throws(() => authenticatedPlan({ ...input, mode: "admission" }));
  }
});
