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

const ownerProbePath = "/internal/acp-owner/incarnation/probe";
const ownerProfile = "acp-owner-bootstrap";

function ownerFixture() {
  const value = fixture();
  value.topology.networks["controller-runtime"] = {};
  value.topology.listeners["agent-acp-service"].owner = {
    network: "controller-runtime",
    port: 8085,
    profile: ownerProfile,
    authentication_before_routing: true,
  };
  value.topology.owner_routes = {
    "agent-acp-service": [`POST ${ownerProbePath}`],
  };
  value.catalogs["agent-acp-service"].routes[`POST ${ownerProbePath}`] = {
    callers: ["runtime-controller"],
    authentication: "workload",
    caller_context: { "runtime-controller": "none" },
    request_body: "json",
  };
  value.networks.push({
    Id: "controller-runtime-id",
    Name: "fixture_controller-runtime",
    Internal: true,
    Labels: {
      "com.docker.compose.project": value.project,
      "com.docker.compose.network": "controller-runtime",
    },
  });
  value.rows[0].NetworkSettings.Networks["fixture_controller-runtime"] = {
    IPAddress: "10.244.49.5",
  };
  return value;
}

function assertOrdinaryACPListeners(plan) {
  for (const [key, port, method, path, status] of [
    ["edge", 8080, "POST", "/rpc/apply", 404],
    ["edge", 8080, "GET", "/rpc/agents/security-probe", 401],
    ["controller-acp", 8081, "POST", "/rpc/apply", 401],
    ["controller-acp", 8081, "GET", "/rpc/agents/security-probe", 404],
    ["edge", 8080, "POST", ownerProbePath, 404],
    ["controller-acp", 8081, "POST", ownerProbePath, 404],
  ]) {
    const network = plan.find((entry) => entry.key === key);
    assert(network, `missing ordinary ACP network ${key}`);
    assert(
      network.probes.some(
        (probe) =>
          probe.service === "agent-acp-service" &&
          probe.port === port &&
          probe.method === method &&
          probe.path === path &&
          probe.status === status &&
          !probe.closed,
      ),
      `${key}:${port} ${method} ${path} must remain ${status}`,
    );
  }
}

test("the optional ACP owner port stays closed on every interface unless its exact profile is enabled", () => {
  for (const profiles of [undefined, []]) {
    const value = ownerFixture();
    const plan = planNetworkMatrix({
      ...value,
      ...(profiles === undefined ? {} : { profiles }),
    });
    assert.equal(plan.length, 5);
    for (const network of plan) {
      const address =
        value.rows[0].NetworkSettings.Networks[network.name].IPAddress;
      const ownInterface = network.probes.filter(
        (probe) =>
          probe.service === "agent-acp-service" &&
          probe.address === address &&
          probe.port === 8085,
      );
      assert(
        ownInterface.length > 0,
        `${network.key}: owner port disappeared from the matrix`,
      );
      assert(
        ownInterface.every((probe) => probe.closed),
        `${network.key}: disabled owner port is open`,
      );
      assert(
        network.probes
          .filter(
            (probe) =>
              probe.service === "agent-acp-service" && probe.port === 8085,
          )
          .every((probe) => probe.closed),
        `${network.key}: disabled owner profile granted a route`,
      );
    }
    assertOrdinaryACPListeners(plan);
  }
});

test("the ACP owner profile opens only its purpose interface, authenticates before routing and keeps its address unreachable from other networks", () => {
  const value = ownerFixture();
  const plan = planNetworkMatrix({ ...value, profiles: [ownerProfile] });
  assert.equal(plan.length, 5);
  const ownerAddress =
    value.rows[0].NetworkSettings.Networks["fixture_controller-runtime"]
      .IPAddress;
  const owner = plan.find((network) => network.key === "controller-runtime");
  assert(owner, "missing owner purpose network");
  const ownerProbes = owner.probes.filter(
    (probe) =>
      probe.service === "agent-acp-service" &&
      probe.address === ownerAddress &&
      probe.port === 8085,
  );
  assert(
    ownerProbes.length > 0,
    "enabled owner listener has no anonymous probes",
  );
  assert(ownerProbes.every((probe) => !probe.closed && probe.status === 401));
  for (const [method, path] of [
    ["POST", ownerProbePath],
    ["POST", "/rpc/apply"],
    ["GET", "/rpc/agents/security-probe"],
    ["GET", "/status"],
  ]) {
    assert(
      ownerProbes.some(
        (probe) =>
          probe.method === method &&
          probe.path === path &&
          probe.status === 401,
      ),
      `owner listener must authenticate anonymous ${method} ${path} before routing`,
    );
  }
  assert(
    ownerProbes.some(
      (probe) =>
        probe.method === "POST" &&
        probe.path === ownerProbePath &&
        probe.body === true,
    ),
  );
  for (const network of plan) {
    if (network.key === "controller-runtime") continue;
    const address =
      value.rows[0].NetworkSettings.Networks[network.name].IPAddress;
    for (const destination of new Set([address, ownerAddress])) {
      const probes = network.probes.filter(
        (probe) =>
          probe.service === "agent-acp-service" &&
          probe.address === destination &&
          probe.port === 8085,
      );
      assert(
        probes.length > 0,
        `${network.key}: missing closed owner destination`,
      );
      assert(
        probes.every((probe) => probe.closed),
        `${network.key}: owner destination is reachable`,
      );
    }
  }
  assertOrdinaryACPListeners(plan);
  const control = plan.find((network) => network.key === "controller-acp");
  const controlProbe = control.probes.find(
    (probe) =>
      probe.port === 8081 &&
      probe.path === "/rpc/apply" &&
      probe.status === 401,
  );
  assert(controlProbe);
  for (const network of plan) {
    if (network.key === "controller-acp") continue;
    assert(
      network.probes.some(
        (probe) =>
          probe.service === "agent-acp-service" &&
          probe.address === controlProbe.address &&
          probe.port === 8081 &&
          probe.closed,
      ),
      `${network.key}: original ACP control isolation disappeared`,
    );
  }
});

test("unknown and malformed profile selections fail closed instead of silently skipping owner admission", () => {
  for (const profiles of [
    ["unknown-profile"],
    ["acp-owner-bootstrp"],
    [ownerProfile, "unknown-profile"],
    [""],
    [1],
    [null],
    ownerProfile,
    null,
    {},
    true,
    1,
  ]) {
    assert.throws(
      () => planNetworkMatrix({ ...ownerFixture(), profiles }),
      `invalid profiles ${JSON.stringify(profiles)} did not reject`,
    );
  }
});

test("enabled owner admission cannot pass when its interface is missing from actual inventory", () => {
  const input = ownerFixture();
  delete input.rows[0].NetworkSettings.Networks["fixture_controller-runtime"];
  assert.throws(() =>
    planNetworkMatrix({ ...input, profiles: [ownerProfile] }),
  );
});
