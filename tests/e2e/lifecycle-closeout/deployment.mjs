import assert from "node:assert/strict";
import { lines } from "./docker.mjs";

export const applicationServices = [
  "runtime-egress",
  "runtime-controller",
  "agent-acp-service",
  "identity-service",
  "agent-controller",
  "admin-console",
  "agent-ui",
  "edge-gateway",
  "skill-registry",
];

export function assertDeployment(config, rows, images) {
  const services = [
    ...applicationServices,
    "postgres",
    "jaeger",
    "stage3-model",
    "temporal",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
  ];
  const published = {
    "diagnostic-relay": [
      ["5432/tcp", config.env.ANTNEST_POSTGRES_HOST_PORT],
      ["16686/tcp", config.env.ANTNEST_JAEGER_UI_HOST_PORT],
    ],
    "edge-gateway": [["8080/tcp", config.env.ANTNEST_EDGE_HOST_PORT]],
    "stage3-model": [
      ["8080/tcp", config.env.ANTNEST_LIFECYCLE_MODEL_HOST_PORT],
    ],
  };
  const names = rows.map((row) => row.labels["com.docker.compose.service"]);
  assert.deepEqual(
    names.sort(),
    services.sort(),
    "missing, duplicate or unexpected Compose service",
  );
  for (const row of rows) {
    const name = row.labels["com.docker.compose.service"];
    assert.equal(row.labels["com.docker.compose.project"], config.project);
    assert.equal(row.running, true, `${name} is not running`);
    assert.equal(
      row.health,
      name === "jaeger" ? "none" : "healthy",
      `${name} readiness`,
    );
    if (applicationServices.includes(name)) {
      assert.match(images[name], /^sha256:[a-f0-9]{64}$/);
      assert.equal(
        row.image,
        images[name],
        `${name} did not start the built image`,
      );
    }
    const actual = Object.entries(row.ports ?? {}).flatMap(([port, bindings]) =>
      (bindings ?? []).map((binding) => [
        port,
        binding.HostIp,
        binding.HostPort,
      ]),
    );
    const expected = published[name];
    assert.deepEqual(
      actual.sort(),
      expected
        ? expected.map(([port, value]) => [port, "127.0.0.1", value]).sort()
        : [],
      `${name} host exposure`,
    );
  }
  return {
    services: services.length,
    applicationImages: applicationServices.length,
    publishedPorts: Object.values(published).reduce(
      (count, entries) => count + entries.length,
      0,
    ),
  };
}

export async function inspectDeployment(config, docker) {
  const ids = lines(
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${config.project}`,
    ]),
  );
  assert(ids.length, "no deployed Compose services");
  // Select facts instead of collecting environments or health-log payloads.
  const format =
    '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"image":{{json .Image}},"running":{{json .State.Running}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}"none"{{end}},"ports":{{json .NetworkSettings.Ports}}}';
  const rows = (await docker(["inspect", "--format", format, ...ids]))
    .split("\n")
    .map((line) => JSON.parse(line));
  const images = {};
  for (const service of applicationServices) {
    images[service] = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      `antnest/${service}:local`,
    ]);
  }
  return assertDeployment(config, rows, images);
}
