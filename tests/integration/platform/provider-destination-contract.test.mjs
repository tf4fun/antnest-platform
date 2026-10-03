import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { test } from "node:test";

const root = new URL("../../../contracts/platform/", import.meta.url);
const fixtures = JSON.parse(
  readFileSync(new URL("provider-destination-fixtures.json", root), "utf8"),
);

test("Provider destination policy freezes common ranges and transport scenarios before adoption", () => {
  assert.equal(fixtures.policy_version, 1);
  assert.equal(
    fixtures.private_flag,
    "ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS",
  );
  const addresses = fixtures.address_vectors;
  assert.equal(
    new Set(addresses.map((item) => item.name)).size,
    addresses.length,
  );
  for (const vector of addresses) {
    assert(isIP(vector.address.split("%")[0]), vector.name);
    assert.equal(typeof vector.default_allowed, "boolean");
    assert.equal(typeof vector.private_opt_in_allowed, "boolean");
    if (vector.default_allowed)
      assert(vector.private_opt_in_allowed, vector.name);
  }
  for (const name of [
    "loopback",
    "rfc1918-10",
    "cgn-first",
    "link-local",
    "metadata-v4",
    "metadata-v6",
    "ula",
    "mapped-loopback",
    "public-v4",
    "public-v6",
    "scoped-address",
  ]) {
    assert(
      addresses.some((vector) => vector.name === name),
      name,
    );
  }
  for (const name of [
    "rebinding-after-validation",
    "mixed-A-and-AAAA",
    "literal-socket-pinning",
    "redirect-without-following",
    "ignore-environment-proxy",
    "credential-absent-from-errors-and-telemetry",
    "deadline-and-cancellation",
  ]) {
    assert(fixtures.required_transport_scenarios.includes(name), name);
  }
  for (const name of [
    "mixed-private",
    "mapped-private",
    "empty",
    "lookup-failure",
  ]) {
    assert(
      fixtures.dns_vectors.some((vector) => vector.name === name),
      name,
    );
  }
});

test("Provider policy records every consumer as pending until its own gate passes", () => {
  const ledger = JSON.parse(
    readFileSync(new URL("service-authentication-rollout.json", root), "utf8"),
  );
  const policy = ledger.provider_destination_policy;
  assert.equal(policy.issue, 28);
  assert.equal(policy.version, 1);
  assert.equal(policy.status, "contract-frozen");
  assert.deepEqual(policy.pending_service_batches, [
    "agent-controller",
    "admin-console",
    "agent-acp-service",
  ]);
  for (const name of [policy.contract, policy.fixtures])
    assert(readFileSync(new URL(name, root)).length);
  assert.equal(policy.cross_service_e2e, "pending final integration batch");
});
