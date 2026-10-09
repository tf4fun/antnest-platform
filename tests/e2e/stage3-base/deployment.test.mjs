import assert from "node:assert/strict";
import test from "node:test";
import { inspectDeployment } from "./deployment.mjs";
const services = [
  "postgres",
  "jaeger",
  "edge-gateway",
  "temporal",
  "runtime-controller",
  "agent-acp-service",
  "identity-service",
  "agent-controller",
  "admin-console",
  "agent-ui",
  "runtime-egress",
  "skill-registry",
  "diagnostic-relay",
  "runtime-telemetry-ingress",
];
const published = {
  "diagnostic-relay": 2,
  "edge-gateway": 1,
};
const fixture = () =>
  services.map((service) => ({
    Name: service,
    Config: {
      Labels: {
        "com.docker.compose.project": "test-project",
        "com.docker.compose.service": service,
      },
    },
    State: {
      Running: true,
      ...(service !== "jaeger" ? { Health: { Status: "healthy" } } : {}),
    },
    HostConfig: {
      PortBindings: Object.fromEntries(
        Array.from({ length: published[service] ?? 0 }, (_, index) => [
          `${8080 + index}/tcp`,
          [{ HostIp: "127.0.0.1", HostPort: String(45000 + index) }],
        ]),
      ),
    },
  }));
test("base deployment has Gateway-only application ingress and loopback diagnostics", () => {
  assert.equal(inspectDeployment(fixture(), "test-project").services, 14);
});
test("Skill Docker race proxy adds one private healthy service", () => {
  const rows = fixture();
  rows.push({
    Name: "skill-docker-proxy",
    Config: {
      Labels: {
        "com.docker.compose.project": "test-project",
        "com.docker.compose.service": "skill-docker-proxy",
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {} },
  });
  assert.equal(inspectDeployment(rows, "test-project", true).services, 15);
});
for (const [label, mutate] of [
  [
    "internal host port",
    (rows) =>
      (rows.find((r) => r.Name === "temporal").HostConfig.PortBindings = {
        "7233/tcp": [{ HostIp: "127.0.0.1", HostPort: "7233" }],
      }),
  ],
  [
    "public diagnostics",
    (rows) =>
      (rows.find((r) => r.Name === "edge-gateway").HostConfig.PortBindings[
        "8080/tcp"
      ][0].HostIp = "0.0.0.0"),
  ],
  [
    "foreign ownership",
    (rows) =>
      (rows[0].Config.Labels["com.docker.compose.project"] = "retained-dev"),
  ],
  [
    "fixed debug ports",
    (rows) =>
      (rows.find((r) => r.Name === "diagnostic-relay").HostConfig.PortBindings[
        "58080/tcp"
      ] = [{ HostIp: "127.0.0.1", HostPort: "58080" }]),
  ],
  ["missing service", (rows) => rows.pop()],
  ["unhealthy service", (rows) => (rows[0].State.Health.Status = "unhealthy")],
])
  test(`reject ${label}`, () => {
    const rows = fixture();
    mutate(rows);
    assert.throws(() => inspectDeployment(rows, "test-project"));
  });
