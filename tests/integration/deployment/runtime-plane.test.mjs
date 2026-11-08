import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const limits = read("contracts/runtime/runtime-plane-limits.json");
const topology = read("contracts/platform/development-network-contract.json");
const envExample = Object.fromEntries(
  readFileSync(new URL(".env.example", root), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/u.test(line))
    .map((line) => line.split("=", 2)),
);

function ipv4(value) {
  const octets = value.split(".").map(Number);
  return octets.reduce((acc, octet) => acc * 256 + octet, 0);
}

function composeDurationSeconds(value) {
  const units = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, amount, unit] of String(value).matchAll(/(\d+)(ms|s|m|h)/gu)) {
    total += Number(amount) * units[unit];
  }
  return total;
}

function cidrContains(cidr, address) {
  const [base, bits] = cidr.split("/");
  const host = 32 - Number(bits);
  const mask = (0xffffffff >>> host) << host;
  return (ipv4(base) & mask) === (ipv4(address) & mask);
}

const base = composeConfig();

test("Runtime Plane parent subnet and dynamic IP range match both contracts", () => {
  assert.equal(
    limits.management_network.default_subnet,
    "172.30.240.0/20",
    "runtime-plane-limits parent subnet",
  );
  assert.equal(
    limits.management_network.default_dynamic_ip_range,
    "172.30.240.0/21",
    "runtime-plane-limits dynamic pool",
  );
  assert.equal(
    topology.runtime_management.default_subnet,
    "172.30.240.0/20",
    "development-network contract parent subnet",
  );
  assert.equal(
    topology.runtime_management.default_dynamic_ip_range,
    "172.30.240.0/21",
    "development-network contract dynamic pool",
  );
  const [ipam] = base.networks["runtime-management"].ipam.config;
  assert.equal(ipam.subnet, "172.30.240.0/20", "compose management subnet");
  assert.equal(ipam.ip_range, "172.30.240.0/21", "compose dynamic IPAM range");
  assert.equal(
    envExample.ANTNEST_RUNTIME_MANAGEMENT_SUBNET,
    "172.30.240.0/20",
    "deployment example parent subnet",
  );
  assert.equal(
    envExample.ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE,
    "172.30.240.0/21",
    "deployment example dynamic IP range",
  );
});

test("retained fixed management addresses sit outside the dynamic pool", () => {
  for (const address of [
    "172.30.255.3",
    "172.30.255.4",
    "172.30.255.5",
    "172.30.255.6",
  ]) {
    assert(
      cidrContains("172.30.240.0/20", address),
      `${address} stays inside the parent subnet`,
    );
    assert(
      !cidrContains("172.30.240.0/21", address),
      `${address} must not consume a dynamic pool slot`,
    );
  }
  assert.deepEqual(
    limits.management_network.static_ipv4.sort(),
    ["172.30.255.3", "172.30.255.4", "172.30.255.5", "172.30.255.6"],
    "all four retained static addresses registered",
  );
});

test("Egress drain timeout and stop grace cover the bounded restart", () => {
  const environment = Object.fromEntries(
    Object.entries(base.services["runtime-egress"].environment).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  assert.equal(
    environment.ANTNEST_EGRESS_DRAIN_TIMEOUT,
    "30s",
    "drain timeout default",
  );
  const grace = composeDurationSeconds(
    base.services["runtime-egress"].stop_grace_period,
  );
  assert.equal(
    grace,
    130,
    "stop grace is exactly 130 seconds after Compose normalization",
  );
  assert(
    grace >= limits.egress_restart.drain_millis.max / 1000 + 5,
    "stop grace covers the maximum drain plus cleanup",
  );
  const custom = composeConfig(["compose.yaml"], {
    ANTNEST_EGRESS_DRAIN_TIMEOUT: "120s",
  });
  const customEnvironment = Object.fromEntries(
    Object.entries(custom.services["runtime-egress"].environment).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  assert.equal(customEnvironment.ANTNEST_EGRESS_DRAIN_TIMEOUT, "120s");
  assert.equal(
    composeDurationSeconds(custom.services["runtime-egress"].stop_grace_period),
    130,
    "stop grace retained for the maximum configured drain",
  );
});

test("legacy explicit /24 subnet override stays allowed with its /25 pool", () => {
  const legacy = composeConfig(["compose.yaml"], {
    ANTNEST_RUNTIME_MANAGEMENT_SUBNET: "172.30.255.0/24",
    ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE: "172.30.255.128/25",
  });
  const [ipam] = legacy.networks["runtime-management"].ipam.config;
  assert.equal(ipam.subnet, "172.30.255.0/24");
  assert.equal(ipam.ip_range, "172.30.255.128/25");
});

test("Runtime Plane contract keeps single-host bounds and scoped resources", () => {
  const control = read("contracts/runtime-controller/control-contract.json");
  const schema = read("contracts/runtime-controller/control-api.ids-v2.schema.json");
  assert.equal(limits.multi_node.in_scope, false);
  assert.equal(limits.multi_node.issue, 74);
  assert.equal(limits.single_docker_host, true);
  assert.equal(
    limits.scope_isolation.container_name,
    "antnest-<scope>-runtime-<agent_id>",
  );
  assert.equal(limits.migration.legacy_workspace_fallback_releases, 1);
  assert.deepEqual(limits.capacity.exhaustion_error, {
    http_status: 503,
    code: "runtime_capacity_exhausted",
    retryable: true,
  });
  assert.equal(control.errors.runtime_capacity_exhausted.status, 503);
  assert.equal(control.errors.runtime_capacity_exhausted.retryable, true);
  for (const name of [
    "runtime_capacity",
    "runtime_count",
    "runtime_capacity_known",
  ]) {
    assert(schema.$defs.readiness.required.includes(name));
  }
  assert.equal(limits.egress_restart.drain_millis.max, 120000);
});
