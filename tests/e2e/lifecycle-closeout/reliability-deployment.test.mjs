import assert from "node:assert/strict";
import test from "node:test";
import { inspectReliabilityDeployment } from "./reliability-deployment.mjs";

const PROJECT = "antnest-lifecycle-deadbeef";

function proxyRow(overrides = {}) {
  const row = {
    Config: {
      Labels: {
        "com.docker.compose.service": "reliability-proxy",
        "com.docker.compose.project": PROJECT,
      },
      Cmd: ["node", "/fixtures/reliability-proxy.mjs"],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: {
      Ports: {},
      Networks: {
        [`${PROJECT}_controller-runtime`]: { IPAddress: "10.241.0.60" },
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/repo/tests/e2e/lifecycle-closeout",
        Destination: "/fixtures",
        RW: false,
      },
    ],
  };
  return { ...row, ...overrides };
}

function baseRow(service) {
  return {
    Config: {
      Labels: {
        "com.docker.compose.service": service,
        "com.docker.compose.project": PROJECT,
      },
      Cmd: ["/app"],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Ports: {}, Networks: {} },
    Mounts: [],
  };
}

const config = {
  project: PROJECT,
  env: { ANTNEST_SERVICE_NETWORK_PREFIX: "10.241.0" },
};

test("inspectReliabilityDeployment returns base rows without the proxy", () => {
  const rows = [
    baseRow("agent-controller"),
    proxyRow(),
    baseRow("runtime-controller"),
  ];
  const original = rows.slice();
  const base = inspectReliabilityDeployment(rows, config);
  assert.equal(base.length, 2);
  assert(
    base.every(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] !== "reliability-proxy",
    ),
  );
  assert.deepEqual(rows, original, "input rows must not be mutated");
});

test("inspectReliabilityDeployment rejects host port exposure", () => {
  const bound = proxyRow({
    HostConfig: {
      PortBindings: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    },
  });
  assert.throws(() =>
    inspectReliabilityDeployment([baseRow("x"), bound], config),
  );
  const mapped = proxyRow({
    NetworkSettings: {
      Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      Networks: {
        [`${PROJECT}_controller-runtime`]: { IPAddress: "10.241.0.60" },
      },
    },
  });
  assert.throws(() =>
    inspectReliabilityDeployment([baseRow("x"), mapped], config),
  );
});

test("inspectReliabilityDeployment rejects missing, duplicate and foreign proxies", () => {
  assert.throws(() => inspectReliabilityDeployment([baseRow("x")], config));
  assert.throws(() =>
    inspectReliabilityDeployment([proxyRow(), proxyRow()], config),
  );
  const foreign = proxyRow();
  foreign.Config.Labels["com.docker.compose.project"] = "antnest-other";
  assert.throws(() => inspectReliabilityDeployment([foreign], config));
});

test("inspectReliabilityDeployment rejects missing health, command and wrong service fields", () => {
  const noHealth = proxyRow({ State: { Running: true } });
  assert.throws(() => inspectReliabilityDeployment([noHealth], config));
  const unhealthy = proxyRow({
    State: { Running: true, Health: { Status: "unhealthy" } },
  });
  assert.throws(() => inspectReliabilityDeployment([unhealthy], config));
  const notRunning = proxyRow({
    State: { Running: false, Health: { Status: "healthy" } },
  });
  assert.throws(() => inspectReliabilityDeployment([notRunning], config));
  const wrongCommand = proxyRow({
    Config: { ...proxyRow().Config, Cmd: ["node", "/fixtures/other.mjs"] },
  });
  assert.throws(() => inspectReliabilityDeployment([wrongCommand], config));
});

test("inspectReliabilityDeployment rejects writable mount and wrong network", () => {
  const writable = proxyRow({
    Mounts: [
      {
        Type: "bind",
        Source: "/repo/tests/e2e/lifecycle-closeout",
        Destination: "/fixtures",
        RW: true,
      },
    ],
  });
  assert.throws(() => inspectReliabilityDeployment([writable], config));
  const wrongSource = proxyRow({
    Mounts: [
      {
        Type: "bind",
        Source: "/repo/other/dir",
        Destination: "/fixtures",
        RW: false,
      },
    ],
  });
  assert.throws(() => inspectReliabilityDeployment([wrongSource], config));
  const wrongAddress = proxyRow({
    NetworkSettings: {
      Ports: {},
      Networks: {
        [`${PROJECT}_controller-runtime`]: { IPAddress: "10.241.0.61" },
      },
    },
  });
  assert.throws(() => inspectReliabilityDeployment([wrongAddress], config));
  const wrongNetwork = proxyRow({
    NetworkSettings: {
      Ports: {},
      Networks: { [`${PROJECT}_other-net`]: { IPAddress: "10.241.0.60" } },
    },
  });
  assert.throws(() => inspectReliabilityDeployment([wrongNetwork], config));
});
