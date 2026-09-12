import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDeployment } from "./deployment.mjs";

const applicationServices = [
  "runtime-egress",
  "runtime-controller",
  "agent-acp-service",
  "identity-service",
  "agent-controller",
  "admin-console",
  "agent-ui",
  "edge-gateway",
];
const bindings = {
  postgres: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45001" }] },
  "edge-gateway": { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "45002" }] },
  jaeger: { "16686/tcp": [{ HostIp: "127.0.0.1", HostPort: "45003" }] },
  "stage3-model": { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "45004" }] },
};
function fixture() {
  const config = {
    project: "antnest-lifecycle-01234567",
    env: {
      ANTNEST_POSTGRES_HOST_PORT: "45001",
      ANTNEST_EDGE_HOST_PORT: "45002",
      ANTNEST_JAEGER_UI_HOST_PORT: "45003",
      ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "45004",
    },
  };
  const images = Object.fromEntries(
    applicationServices.map((name, i) => [
      name,
      `sha256:${String(i).repeat(64)}`,
    ]),
  );
  const rows = [
    ...applicationServices,
    "postgres",
    "jaeger",
    "stage3-model",
  ].map((service) => ({
    id: `container-${service}`,
    labels: {
      "com.docker.compose.project": config.project,
      "com.docker.compose.service": service,
    },
    image: images[service] ?? "dependency-image",
    running: true,
    health: service === "jaeger" ? "none" : "healthy",
    ports: structuredClone(bindings[service] ?? { "8080/tcp": null }),
  }));
  return { config, images, rows };
}

test("deployment inspection proves current images, health and exact loopback bindings", () => {
  const { config, images, rows } = fixture();
  assert.deepEqual(assertDeployment(config, rows, images), {
    services: 11,
    applicationImages: 8,
    publishedPorts: 4,
  });
});

for (const [name, mutate] of [
  ["missing service", (f) => f.rows.pop()],
  ["duplicate service", (f) => f.rows.push(structuredClone(f.rows[0]))],
  [
    "foreign project",
    (f) => {
      f.rows[0].labels["com.docker.compose.project"] = "other";
    },
  ],
  [
    "stale application image",
    (f) => {
      f.rows[0].image = "old-image";
    },
  ],
  [
    "unhealthy service",
    (f) => {
      f.rows[0].health = "unhealthy";
    },
  ],
  [
    "stopped service",
    (f) => {
      f.rows[0].running = false;
    },
  ],
  [
    "internal host port",
    (f) => {
      f.rows[0].ports["8080/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "8080" }];
    },
  ],
  [
    "public host binding",
    (f) => {
      f.rows.find(
        (r) => r.labels["com.docker.compose.service"] === "edge-gateway",
      ).ports["8080/tcp"][0].HostIp = "0.0.0.0";
    },
  ],
  [
    "wrong host port",
    (f) => {
      f.rows.find(
        (r) => r.labels["com.docker.compose.service"] === "postgres",
      ).ports["5432/tcp"][0].HostPort = "9999";
    },
  ],
]) {
  test(`deployment inspection rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertDeployment(f.config, f.rows, f.images));
  });
}
