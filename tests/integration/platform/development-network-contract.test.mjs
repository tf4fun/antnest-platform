import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
function readContract() {
  const file = new URL(
    "contracts/platform/development-network-contract.json",
    root,
  );
  assert(existsSync(file), "missing development network contract");
  return JSON.parse(readFileSync(file, "utf8"));
}
const credentials = JSON.parse(
  readFileSync(
    new URL(
      "contracts/platform/development-authentication-contract.json",
      root,
    ),
    "utf8",
  ),
);

test("every current workload pair shares the receiver's explicitly bound purpose network", () => {
  const contract = readContract();
  assert.equal(contract.version, 1);
  assert.equal(contract.status, "contract-frozen-implementation-pending");
  assert.equal(
    contract.service_prefix_environment,
    "ANTNEST_SERVICE_NETWORK_PREFIX",
  );
  assert.equal(contract.default_service_prefix, "10.241.0");
  const pairs = new Set();
  for (const [receiver, path] of Object.entries(credentials.static_services)) {
    const catalog = JSON.parse(readFileSync(new URL(path, root), "utf8"));
    assert(contract.listeners[receiver], receiver);
    for (const [routeName, route] of Object.entries(catalog.routes)) {
      if (route.authentication !== "workload") continue;
      for (const caller of route.callers) {
        const purpose = contract.control_routes[receiver]?.includes(routeName)
          ? "control"
          : "primary";
        const listener = contract.listeners[receiver][purpose];
        assert(listener, `${receiver} listener`);
        const network = contract.networks[listener.network];
        assert.equal(network.internal, true, `${caller}->${receiver}`);
        assert(
          network.members[caller] !== undefined,
          `${caller}->${receiver} missing purpose membership`,
        );
        assert.equal(network.members[receiver], listener.address_suffix);
        pairs.add(`${caller}->${receiver}`);
      }
    }
  }
  assert.equal(pairs.size, 23);
  assert.deepEqual(contract.control_routes, {
    "agent-acp-service": [
      "POST /rpc/agent-acp/apply-execution-snapshot",
      "POST /rpc/agent-acp/settle-agent",
    ],
  });
  assert.notEqual(
    contract.listeners["agent-acp-service"].control.network,
    contract.listeners["agent-acp-service"].primary.network,
  );
});

test("static purpose addresses are unique and fit their private /28 subnets", () => {
  const { networks, listeners } = readContract();
  const starts = new Set();
  for (const [name, network] of Object.entries(networks)) {
    if (network.subnet_environment) {
      assert.equal(name, "control");
      assert.equal(network.default_subnet, "172.31.255.0/24");
      assert.deepEqual(network.members, {
        "runtime-egress": 3,
        "agent-controller": 4,
      });
      continue;
    }
    assert(Number.isInteger(network.subnet_suffix));
    assert.equal(network.subnet_suffix % 16, 0, name);
    assert(!starts.has(network.subnet_suffix), name);
    starts.add(network.subnet_suffix);
    const addresses = Object.values(network.members);
    assert.equal(new Set(addresses).size, addresses.length, name);
    for (const address of addresses) {
      assert(Number.isInteger(address), name);
      assert(
        address > network.subnet_suffix + 1 &&
          address < network.subnet_suffix + 15,
        name,
      );
    }
  }
  for (const service of Object.values(listeners))
    for (const listener of Object.values(service))
      assert(
        Number.isInteger(listener.port) &&
          listener.port > 0 &&
          listener.port <= 65535,
      );
});

test("management has a bounded OTLP-only infrastructure destination and no collector or business ingress", () => {
  const contract = readContract();
  assert.deepEqual(contract.runtime_management.static_members, [
    "runtime-controller",
    "agent-acp-service",
    "runtime-egress",
    "runtime-telemetry-ingress",
  ]);
  assert.equal(contract.runtime_management.dynamic_member, "antnest-runtime");
  assert.equal(contract.runtime_management.business_listeners, false);
  assert.equal(contract.runtime_management.jaeger_member, false);
  assert.equal(contract.runtime_management.diagnostics_member, false);
  const ingress = contract.infrastructure.runtime_telemetry_ingress;
  assert.deepEqual(ingress.methods, ["POST"]);
  assert.deepEqual(ingress.paths, ["/v1/traces", "/v1/metrics", "/v1/logs"]);
  assert.equal(ingress.upstream, "jaeger");
  assert.equal(ingress.upstream_port, 4318);
  assert.equal(ingress.max_wire_body_bytes, 8 * 1024 * 1024);
  assert.equal(ingress.max_inflight, 8);
  assert.equal(ingress.forward_authority_headers, false);
  assert.equal(ingress.business_credential_mounts, false);
});

test("only Gateway and the explicit diagnostic transport have host ingress networks", () => {
  const contract = readContract();
  for (const [name, network] of Object.entries(contract.networks)) {
    if (network.internal) continue;
    assert(["gateway-ingress", "diagnostic-ingress"].includes(name));
  }
  assert.deepEqual(Object.keys(contract.networks["gateway-ingress"].members), [
    "edge-gateway",
  ]);
  assert.deepEqual(
    Object.keys(contract.networks["diagnostic-ingress"].members),
    ["diagnostic-relay"],
  );
  const diagnostics = contract.infrastructure.diagnostics;
  assert.equal(diagnostics.publisher, "diagnostic-relay");
  assert.equal(diagnostics.profile, "diagnostics");
  assert.equal(diagnostics.enabled_by_debug_overlay, true);
  assert.equal(diagnostics.business_credential_mounts, false);
  assert.equal(diagnostics.transport, "opaque-tcp");
  assert.equal(diagnostics.max_connections, 64);
  assert.equal(diagnostics.max_buffer_bytes_per_stream, 65536);
  assert.deepEqual(
    Object.keys(diagnostics.listener_ports).sort(),
    Object.keys(credentials.host_ports.debug_publications).sort(),
  );
  const ports = Object.values(diagnostics.listener_ports);
  assert.equal(new Set(ports).size, ports.length);
  assert(
    !ports.includes(8081),
    "Controller-only ACP listener is not a diagnostic route",
  );
  assert.equal(diagnostics.stage3_port_suppression, "explicit-test-override");
});

test("canonical workload destinations select receiver purpose addresses instead of multihomed DNS", () => {
  const contract = readContract();
  assert.equal(contract.destination_resolution, "purpose-address-extra-hosts");
  for (const [receiver, path] of Object.entries(credentials.static_services)) {
    const catalog = JSON.parse(readFileSync(new URL(path, root), "utf8"));
    for (const [routeName, route] of Object.entries(catalog.routes)) {
      if (route.authentication !== "workload") continue;
      const purpose = contract.control_routes[receiver]?.includes(routeName)
        ? "control"
        : "primary";
      const listener = contract.listeners[receiver][purpose];
      for (const caller of route.callers) {
        const destination = contract.destinations[caller][listener.dns_name];
        assert(destination, `${caller}->${listener.dns_name}`);
        assert.equal(destination.receiver, receiver);
        assert.equal(destination.listener, purpose);
      }
    }
  }
  assert.deepEqual(
    credentials.development_pki.leaf.dns_aliases["agent-acp-service"].sort(),
    [
      contract.listeners["agent-acp-service"].control.dns_name,
      contract.listeners["agent-acp-service"].primary.dns_name,
    ].sort(),
  );
});

test("outbound Internet paths and database memberships cannot introduce business ingress", () => {
  const contract = readContract();
  assert.deepEqual(contract.outbound_networks, {
    "identity-outbound": { internal: false, members: ["identity-service"] },
    "controller-provider": { internal: false, members: ["agent-controller"] },
    "acp-provider": { internal: false, members: ["agent-acp-service"] },
    egress: { internal: false, members: ["runtime-egress"] },
  });
  const owners = new Set([
    "runtime-egress",
    "runtime-controller",
    "agent-acp-service",
    "identity-service",
    "agent-controller",
    "skill-registry",
    "temporal",
  ]);
  assert.equal(Object.keys(contract.database_networks).length, owners.size);
  for (const network of Object.values(contract.database_networks)) {
    assert.equal(network.internal, true);
    assert(owners.delete(network.owner), network.owner);
    assert.equal(network.database, "postgres");
    assert.equal(network.independent_roles, true);
  }
  assert.equal(owners.size, 0);
});
