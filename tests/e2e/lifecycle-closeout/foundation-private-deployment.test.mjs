import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applicationServices, assertDeployment } from "./deployment.mjs";
import { inspectFoundationDeployment } from "./foundation-setup.mjs";
import { composeConfig } from "../../support/compose-config.mjs";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";
const url = new URL("./foundation-private-deployment.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  const project = "antnest-lifecycle-01234567";
  const config = {
    project,
    credentials: "/original-inner/credentials",
    env: {
      ANTNEST_SERVICE_NETWORK_PREFIX: "10.241.7",
      ANTNEST_POSTGRES_HOST_PORT: "45000",
      ANTNEST_JAEGER_UI_HOST_PORT: "45001",
      ANTNEST_EDGE_HOST_PORT: "45005",
      ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "45006",
    },
    compose: (args) => ["base", ...args],
  };
  const row = (name, ports) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
      },
      Image: "node:24.21.0-bookworm-slim",
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: ports },
    NetworkSettings: { Ports: structuredClone(ports), Networks: {} },
  });
  const ports = (names, start = 45000) =>
    Object.fromEntries(
      names.map((port, i) => [
        `${port}/tcp`,
        [{ HostIp: "127.0.0.1", HostPort: String(start + i) }],
      ]),
    );
  const relay = row("diagnostic-relay", ports([5432, 16686, 58081, 58082]));
  const exporter = row("foundation-client-telemetry", ports([4318], 45004));
  Object.assign(exporter.Config, {
    User: "65532:65532",
    Cmd: [
      "node",
      "/opt/antnest/scripts/deployment/runtime-telemetry-ingress.mjs",
    ],
    Env: [
      "ANTNEST_SERVICE_NETWORK_PREFIX=10.241.7",
      "ANTNEST_RUNTIME_OTLP_INGRESS_IPV4=10.241.7.147",
    ],
  });
  Object.assign(exporter.HostConfig, {
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
  });
  exporter.Mounts = [
    "/opt/antnest/scripts/deployment",
    "/opt/antnest/contracts/platform/development-network-contract.json",
  ].map((Destination) => ({ Type: "bind", Destination, RW: false }));
  exporter.NetworkSettings.Networks = {
    [project + "_diagnostic-ingress"]: { IPAddress: "10.241.7.147" },
    [project + "_observability"]: { IPAddress: "10.241.7.126" },
  };
  const others = [
    ...applicationServices,
    "postgres",
    "temporal",
    "jaeger",
    "stage3-model",
    "runtime-telemetry-ingress",
  ].map((name) =>
    row(
      name,
      name === "edge-gateway"
        ? ports([8080], 45005)
        : name === "stage3-model"
          ? ports([8080], 45006)
          : {},
    ),
  );
  const images = Object.fromEntries(
    applicationServices.map((name, i) => [
      name,
      "sha256:" + String(i).repeat(64),
    ]),
  );
  for (const r of others) {
    r.Image = images[r.Config.Labels["com.docker.compose.service"]];
    if (r.Config.Labels["com.docker.compose.service"] === "jaeger")
      delete r.State.Health;
  }
  return {
    config,
    rows: [relay, exporter, ...others],
    relay,
    exporter,
    images,
  };
}
test("default Foundation adds only its private overlay and validates exact loopback bindings", () => {
  assert.equal(typeof implementation.configureFoundationPrivate, "function");
  assert.equal(
    typeof implementation.inspectFoundationPrivateDeployment,
    "function",
  );
  const f = fixture();
  implementation.configureFoundationPrivate(f.config);
  assert.deepEqual(f.config.compose(["up"]), [
    "base",
    "-f",
    "tests/e2e/lifecycle-closeout/foundation-private.compose.yaml",
    "up",
  ]);
  const before = JSON.stringify(f.rows);
  const base = implementation.inspectFoundationPrivateDeployment(
    f.rows,
    f.config,
  );
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(base.length, 15);
  assert.equal(inspectFoundationDeployment(base, f.config).services, 15);
  const project = () =>
    base.map((r) => ({
      labels: r.Config.Labels,
      image: r.Image,
      running: r.State.Running,
      health: r.State.Health?.Status ?? "none",
      ports: r.NetworkSettings.Ports,
    }));
  assert.deepEqual(assertDeployment(f.config, project(), f.images), {
    services: 15,
    applicationImages: 9,
    publishedPorts: 4,
  });
  const wrongImage = structuredClone(project());
  wrongImage.find(
    (r) => r.labels["com.docker.compose.service"] === "agent-acp-service",
  ).image = "sha256:" + "f".repeat(64);
  assert.throws(() => assertDeployment(f.config, wrongImage, f.images));
  assert.deepEqual(Object.keys(base[0].NetworkSettings.Ports), [
    "5432/tcp",
    "16686/tcp",
  ]);
  assert.deepEqual(f.config.privateAccess, {
    acp: "http://127.0.0.1:45002",
    identity: "http://127.0.0.1:45003",
    otlp: "http://127.0.0.1:45004/v1/traces",
    credentials: "/original-inner/credentials",
  });
});
for (const [name, mutate] of [
  [
    "public ACP binding",
    (f) => {
      f.relay.NetworkSettings.Ports["58081/tcp"][0].HostIp = "0.0.0.0";
    },
  ],
  [
    "extra private exposure",
    (f) => {
      f.relay.NetworkSettings.Ports["58080/tcp"] = [
        { HostIp: "127.0.0.1", HostPort: "40000" },
      ];
    },
  ],
  [
    "foreign project",
    (f) => {
      f.exporter.Config.Labels["com.docker.compose.project"] = "other";
    },
  ],
  [
    "missing exporter",
    (f) => {
      f.rows.splice(f.rows.indexOf(f.exporter), 1);
    },
  ],
  [
    "duplicate exporter",
    (f) => {
      f.rows.push(f.exporter);
    },
  ],
  [
    "wrong exporter network",
    (f) => {
      f.exporter.NetworkSettings.Networks[
        f.config.project + "_observability"
      ].IPAddress = "10.241.7.127";
    },
  ],
  [
    "unhealthy exporter",
    (f) => {
      f.exporter.State.Health.Status = "unhealthy";
    },
  ],
  ["missing port", (f) => delete f.relay.NetworkSettings.Ports["58081/tcp"]],
  [
    "duplicate binding",
    (f) =>
      f.relay.NetworkSettings.Ports["58081/tcp"].push({
        HostIp: "127.0.0.1",
        HostPort: "45007",
      }),
  ],
  ["stopped exporter", (f) => (f.exporter.State.Running = false)],
  [
    "extra exporter network",
    (f) => (f.exporter.NetworkSettings.Networks.extra = {}),
  ],
  ["wrong exporter image", (f) => (f.exporter.Config.Image = "node:other")],
  ["missing inner credentials", (f) => delete f.config.credentials],
  ["root exporter", (f) => (f.exporter.Config.User = "0")],
  [
    "writable exporter root",
    (f) => (f.exporter.HostConfig.ReadonlyRootfs = false),
  ],
  ["privileged exporter", (f) => (f.exporter.HostConfig.CapDrop = [])],
  [
    "wrong exporter command",
    (f) => (f.exporter.Config.Cmd = ["node", "elsewhere"]),
  ],
  ["writable exporter source", (f) => (f.exporter.Mounts[0].RW = true)],
  ["missing exporter contract", (f) => f.exporter.Mounts.pop()],
  [
    "wrong ingress binding",
    (f) =>
      (f.exporter.Config.Env[1] = "ANTNEST_RUNTIME_OTLP_INGRESS_IPV4=0.0.0.0"),
  ],
])
  test(`Foundation private deployment rejects ${name}`, () => {
    assert.equal(
      typeof implementation.inspectFoundationPrivateDeployment,
      "function",
    );
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      implementation.inspectFoundationPrivateDeployment(f.rows, f.config),
    );
  });

test("default Foundation overlay renders the intended diagnostic relay and confined exporter", () => {
  const env = fixtureEnvironment(
    {},
    { project: "antnest-lifecycle-01234567", octet: 187 },
  );
  Object.assign(env, {
    ANTNEST_POSTGRES_HOST_PORT: "45100",
    ANTNEST_JAEGER_UI_HOST_PORT: "45101",
    ANTNEST_LIFECYCLE_CONTROL_DYNAMIC_RANGE: "10.242.187.128/25",
    ANTNEST_LIFECYCLE_RUNTIME_DYNAMIC_RANGE: "10.243.187.128/25",
  });
  const config = composeConfig(
    [
      "compose.yaml",
      "compose.debug.yaml",
      "compose.stage3.yaml",
      "tests/support/compose.public-development-secrets.yaml",
      "tests/e2e/lifecycle-closeout/compose.yaml",
      "tests/e2e/lifecycle-closeout/foundation.compose.yaml",
      "tests/e2e/lifecycle-closeout/foundation-private.compose.yaml",
    ],
    env,
  );
  const relay = config.services["diagnostic-relay"],
    exporter = config.services["foundation-client-telemetry"];
  assert.deepEqual(
    relay.ports.map((p) => [p.host_ip, p.target]),
    [
      ["127.0.0.1", 5432],
      ["127.0.0.1", 16686],
      ["127.0.0.1", 58081],
      ["127.0.0.1", 58082],
    ],
  );
  assert(Object.hasOwn(relay.networks, "diagnostic-ingress"));
  assert.equal(exporter.user, "65532:65532");
  assert.equal(exporter.read_only, true);
  assert.deepEqual(exporter.cap_drop, ["ALL"]);
  assert.deepEqual(exporter.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(exporter.command, [
    "node",
    "/opt/antnest/scripts/deployment/runtime-telemetry-ingress.mjs",
  ]);
  assert.equal(
    exporter.environment.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4,
    env.ANTNEST_SERVICE_NETWORK_PREFIX + ".147",
  );
  assert.deepEqual(Object.keys(exporter.networks).sort(), [
    "diagnostic-ingress",
    "observability",
  ]);
  assert.equal(
    exporter.networks["diagnostic-ingress"].ipv4_address,
    env.ANTNEST_SERVICE_NETWORK_PREFIX + ".147",
  );
  assert.equal(
    exporter.networks.observability.ipv4_address,
    env.ANTNEST_SERVICE_NETWORK_PREFIX + ".126",
  );
  assert.deepEqual(
    exporter.volumes.map((v) => [v.target, v.read_only]).sort(),
    [
      [
        "/opt/antnest/contracts/platform/development-network-contract.json",
        true,
      ],
      ["/opt/antnest/scripts/deployment", true],
    ],
  );
  assert.deepEqual(
    exporter.ports.map((p) => [p.host_ip, p.target]),
    [["127.0.0.1", 4318]],
  );
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(profile === "foundation"\) configureFoundationPrivate\(config\);/u,
  );
});
