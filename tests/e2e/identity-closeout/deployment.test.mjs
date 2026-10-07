import assert from "node:assert/strict";
import test from "node:test";
import { inspectIdentityDeployment } from "./deployment.mjs";
function rows() {
  return [
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
    "oidc-fixture",
  ].map((name) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": "fixture",
        "com.docker.compose.service": name,
      },
      Env:
        name === "identity-service"
          ? ["SSL_CERT_FILE=/test-ca/tls.crt", "ANTNEST_IDENTITY_TOKEN_TTL=12h"]
          : [],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: {
      PortBindings:
        name === "diagnostic-relay"
          ? {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "48002" }],
              "16686/tcp": [{ HostIp: "127.0.0.1", HostPort: "48003" }],
            }
          : ["edge-gateway", "oidc-fixture"].includes(name)
            ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "48001" }] }
            : {},
    },
    Mounts:
      name === "identity-service"
        ? [{ Destination: "/test-ca", RW: false }]
        : [],
  }));
}
test("Identity deployment requires actual HTTPS trust and isolated ingress", () => {
  assert.equal(inspectIdentityDeployment(rows(), "fixture").services, 15);
  for (const mutate of [
    (r) =>
      (r.find(
        (x) =>
          x.Config.Labels["com.docker.compose.service"] === "identity-service",
      ).Config.Env = []),
    (r) =>
      (r.find(
        (x) =>
          x.Config.Labels["com.docker.compose.service"] === "identity-service",
      ).Mounts[0].RW = true),
    (r) =>
      (r.find(
        (x) => x.Config.Labels["com.docker.compose.service"] === "temporal",
      ).HostConfig.PortBindings = {
        "7233/tcp": [{ HostIp: "127.0.0.1", HostPort: "7233" }],
      }),
    (r) => (r.at(-1).HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"),
    (r) => (r.at(-1).State.Health.Status = "unhealthy"),
  ]) {
    const value = rows();
    mutate(value);
    assert.throws(() => inspectIdentityDeployment(value, "fixture"));
  }
});
