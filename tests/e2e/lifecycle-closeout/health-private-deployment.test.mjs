import assert from "node:assert/strict";
import test from "node:test";
import { applicationServices, assertDeployment } from "./deployment.mjs";
import { inspectFoundationDeployment } from "./foundation-setup.mjs";
import { composeConfig } from "../../support/compose-config.mjs";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";
const url = new URL("./health-private-deployment.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  assert.equal(
    typeof implementation.inspectHealthPrivateDeployment,
    "function",
  );
  const config = {
    project: "antnest-lifecycle-1234abcd",
    credentials: "/inner/credentials",
    env: {
      ANTNEST_POSTGRES_HOST_PORT: "45000",
      ANTNEST_JAEGER_UI_HOST_PORT: "45001",
      ANTNEST_EDGE_HOST_PORT: "45000",
      ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "45000",
    },
    compose: (args) => ["base", ...args],
  };
  const names = [
    ...applicationServices,
    "postgres",
    "temporal",
    "jaeger",
    "stage3-model",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
  ];
  const images = Object.fromEntries(
    applicationServices.map((name, i) => [
      name,
      "sha256:" + String(i).repeat(64),
    ]),
  );
  const rows = names.map((name) => {
    const ports =
      name === "diagnostic-relay"
        ? [5432, 16686, 58081, 58082]
        : ["edge-gateway", "stage3-model"].includes(name)
          ? [8080]
          : [];
    const bindings = Object.fromEntries(
      ports.map((p, i) => [
        p + "/tcp",
        [{ HostIp: "127.0.0.1", HostPort: String(45000 + i) }],
      ]),
    );
    return {
      Config: {
        Labels: {
          "com.docker.compose.project": config.project,
          "com.docker.compose.service": name,
        },
      },
      Image: images[name],
      State: {
        Running: true,
        ...(name === "jaeger" ? {} : { Health: { Status: "healthy" } }),
      },
      HostConfig: { PortBindings: structuredClone(bindings) },
      NetworkSettings: { Ports: bindings },
    };
  });

  return {
    config,
    rows,
    images,
    relay: rows.find(
      (r) =>
        r.Config.Labels["com.docker.compose.service"] === "diagnostic-relay",
    ),
  };
}
test("Health exposes only two private relay ports and preserves all fifteen service/image checks", () => {
  const f = fixture();
  implementation.configureHealthPrivate(f.config);
  assert.deepEqual(f.config.compose(["up"]), [
    "base",
    "-f",
    "tests/e2e/lifecycle-closeout/health-private.compose.yaml",
    "up",
  ]);
  const raw = JSON.stringify(f.rows);
  const base = implementation.inspectHealthPrivateDeployment(f.rows, f.config);
  assert.equal(JSON.stringify(f.rows), raw);
  assert.equal(inspectFoundationDeployment(base, f.config).services, 15);
  const projected = base.map((r) => ({
    labels: r.Config.Labels,
    image: r.Image,
    running: r.State.Running,
    health: r.State.Health?.Status ?? "none",
    ports: r.NetworkSettings.Ports,
  }));
  assert.equal(
    assertDeployment(f.config, projected, f.images).applicationImages,
    9,
  );
  assert.deepEqual(f.config.healthPrivateAccess, {
    acp: "http://127.0.0.1:45002",
    identity: "http://127.0.0.1:45003",
    credentials: "/inner/credentials",
  });
});
for (const [name, mutate] of [
  [
    "public observed binding",
    (f) => {
      f.relay.NetworkSettings.Ports["58081/tcp"][0].HostIp = "0.0.0.0";
    },
  ],
  [
    "public configured binding",
    (f) => {
      f.relay.HostConfig.PortBindings["58082/tcp"][0].HostIp = "0.0.0.0";
    },
  ],
  [
    "extra port",
    (f) => {
      f.relay.NetworkSettings.Ports["9999/tcp"] = [
        { HostIp: "127.0.0.1", HostPort: "9999" },
      ];
    },
  ],
  ["duplicate relay", (f) => f.rows.push(structuredClone(f.relay))],
  [
    "foreign project",
    (f) => {
      f.relay.Config.Labels["com.docker.compose.project"] = "foreign";
    },
  ],
  [
    "unhealthy relay",
    (f) => {
      f.relay.State.Health.Status = "unhealthy";
    },
  ],
  [
    "invalid port",
    (f) => {
      f.relay.NetworkSettings.Ports["58082/tcp"][0].HostPort = "0";
    },
  ],
  [
    "shared port",
    (f) => {
      f.relay.NetworkSettings.Ports["58082/tcp"][0].HostPort = "45002";
    },
  ],
])
  test(`Health private boundary rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      implementation.inspectHealthPrivateDeployment(f.rows, f.config),
    );
  });

test("Health overlay changes only the two private relay publications", () => {
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
  const files = [
    "compose.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "tests/support/compose.public-development-secrets.yaml",
    "tests/e2e/lifecycle-closeout/compose.yaml",
    "tests/e2e/lifecycle-closeout/foundation.compose.yaml",
  ];
  const base = composeConfig(files, env);
  const health = composeConfig(
    [...files, "tests/e2e/lifecycle-closeout/health-private.compose.yaml"],
    env,
  );
  assert.deepEqual(
    health.services["diagnostic-relay"].ports.map((p) => [p.host_ip, p.target]),
    [
      ["127.0.0.1", 5432],
      ["127.0.0.1", 16686],
      ["127.0.0.1", 58081],
      ["127.0.0.1", 58082],
    ],
  );
  health.services["diagnostic-relay"].ports =
    base.services["diagnostic-relay"].ports;
  assert.deepEqual(health, base);
});
