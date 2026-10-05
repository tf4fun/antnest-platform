import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planNetworkMatrix } from "./network-matrix.mjs";

const fixture = () => ({
  project: "antnest-lifecycle-1234abcd",
  topology: {
    networks: { edge: {}, "controller-acp": {} },
    outbound_networks: { "acp-provider": {} },
    database_networks: { "agent-acp-database": {} },
    listeners: {
      "agent-acp-service": {
        primary: { network: "edge", port: 8080 },
        control: { network: "controller-acp", port: 8081 },
      },
    },
    control_routes: { "agent-acp-service": ["POST /rpc/apply"] },
  },
  catalogs: {
    "agent-acp-service": {
      service: "agent-acp-service",
      status: "enforced",
      routes: {
        "POST /rpc/apply": { authentication: "workload", request_body: "json" },
        "GET /rpc/agents/{agent_id}": {
          authentication: "workload",
          request_body: "none",
        },
        "GET /status": { authentication: "health", request_body: "none" },
      },
    },
  },
  networks: [
    "edge",
    "controller-acp",
    "acp-provider",
    "agent-acp-database",
  ].map((name) => ({
    Id: `${name}-id`,
    Name: `fixture_${name}`,
    Internal: !name.endsWith("provider"),
    Labels: {
      "com.docker.compose.project": "antnest-lifecycle-1234abcd",
      "com.docker.compose.network": name,
    },
  })),
  rows: [
    {
      Config: {
        Labels: {
          "com.docker.compose.project": "antnest-lifecycle-1234abcd",
          "com.docker.compose.service": "agent-acp-service",
        },
      },
      NetworkSettings: {
        Networks: Object.fromEntries(
          ["edge", "controller-acp", "acp-provider", "agent-acp-database"].map(
            (name, i) => [
              `fixture_${name}`,
              { IPAddress: `10.244.${45 + i}.5` },
            ],
          ),
        ),
      },
    },
  ],
});

test("the production catalogs, including wildcard registrations, all enter the matrix", () => {
  const root = new URL("../../../", import.meta.url);
  const contract = JSON.parse(
    readFileSync(
      new URL(
        "contracts/platform/development-authentication-contract.json",
        root,
      ),
      "utf8",
    ),
  );
  const topology = JSON.parse(
    readFileSync(
      new URL("contracts/platform/development-network-contract.json", root),
      "utf8",
    ),
  );
  const catalogs = Object.fromEntries(
    Object.entries(contract.static_services).map(([service, path]) => [
      service,
      JSON.parse(readFileSync(new URL(path, root), "utf8")),
    ]),
  );
  const project = "antnest-lifecycle-1234abcd";
  const keys = [
    ...Object.keys(topology.networks),
    ...Object.keys(topology.outbound_networks),
    ...Object.keys(topology.database_networks),
    "runtime-management",
  ];
  const networks = keys.map((key) => ({
    Id: key,
    Name: `fixture_${key}`,
    Internal: true,
    Labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.network": key,
    },
  }));
  const rows = Object.keys(catalogs).map((service) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
      },
    },
    NetworkSettings: {
      Networks: Object.fromEntries(
        keys
          .filter((key) => {
            if (key === "runtime-management")
              return topology.runtime_management.static_members.includes(
                service,
              );
            return (
              Object.hasOwn(topology.networks[key]?.members ?? {}, service) ||
              topology.outbound_networks[key]?.members.includes(service) ||
              topology.database_networks[key]?.owner === service
            );
          })
          .map((key, i) => [
            `fixture_${key}`,
            { IPAddress: `192.0.2.${i + 2}` },
          ]),
      ),
    },
  }));
  const plan = planNetworkMatrix({
    project,
    topology,
    catalogs,
    networks,
    rows,
  });
  assert.deepEqual(new Set(plan.map((network) => network.key)), new Set(keys));
  for (const [service, catalog] of Object.entries(catalogs)) {
    const routes = Object.entries(catalog.routes).filter(
      ([, rule]) => rule.authentication === "workload",
    );
    for (const [route] of routes) {
      const [method, path] = route.split(" ");
      const expected = path.replace(/\{[^}]+\}/gu, "security-probe");
      assert(
        plan.some((network) =>
          network.probes.some(
            (probe) =>
              probe.service === service &&
              probe.path === expected &&
              (method === "*" ||
                (method === "UPGRADE"
                  ? probe.upgrade
                  : probe.method === method)),
          ),
        ),
        route,
      );
    }
  }
});

test("every attached network is tested; control routes are never accepted by the workspace listener", () => {
  const plan = planNetworkMatrix(fixture());
  assert.equal(plan.length, 4);
  assert(plan.every((network) => network.probes.length > 0));
  const edge = plan.find((network) => network.key === "edge");
  assert(
    edge.probes.some(
      (probe) => probe.path === "/rpc/apply" && probe.status === 404,
    ),
  );
  assert(
    edge.probes.some(
      (probe) => probe.path.startsWith("/rpc/agents/") && probe.status === 401,
    ),
  );
  assert(
    !edge.probes.some(
      (probe) => probe.path === "/status" && probe.status === 200,
    ),
  );
  const control = plan.find((network) => network.key === "controller-acp");
  assert(
    control.probes.some(
      (probe) =>
        probe.path === "/rpc/apply" &&
        probe.port === 8081 &&
        probe.status === 401,
    ),
  );
  for (const key of ["acp-provider", "agent-acp-database"])
    assert(
      plan
        .find((network) => network.key === key)
        .probes.every((probe) => probe.closed),
    );
});

test("missing, foreign and unclassified networks cannot silently disappear from the matrix", () => {
  for (const mutate of [
    (value) => value.networks.pop(),
    (value) =>
      (value.networks[0].Labels["com.docker.compose.project"] = "retained"),
    (value) =>
      (value.networks[0].Labels["com.docker.compose.network"] = "unlisted"),
    (value) => (value.catalogs["agent-acp-service"].status = "draft"),
    (value) =>
      (value.rows[0].NetworkSettings.Networks.fixture_edge.IPAddress = ""),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => planNetworkMatrix(value));
  }
});
