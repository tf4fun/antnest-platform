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
