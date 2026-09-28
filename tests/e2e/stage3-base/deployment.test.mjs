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
];
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
      PortBindings: ["postgres", "jaeger", "edge-gateway"].includes(service)
        ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "45000" }] }
        : {},
    },
  }));
test("base deployment has Gateway-only application ingress and loopback diagnostics", () => {
  assert.equal(inspectDeployment(fixture(), "test-project").services, 12);
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
  assert.equal(inspectDeployment(rows, "test-project", true).services, 13);
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
      (rows[0].HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"),
  ],
  [
    "foreign ownership",
    (rows) =>
      (rows[0].Config.Labels["com.docker.compose.project"] = "retained-dev"),
  ],
  ["missing service", (rows) => rows.pop()],
  ["unhealthy service", (rows) => (rows[0].State.Health.Status = "unhealthy")],
])
  test(`reject ${label}`, () => {
    const rows = fixture();
    mutate(rows);
    assert.throws(() => inspectDeployment(rows, "test-project"));
  });
