import assert from "node:assert/strict";
import test from "node:test";
import { inspectIdentityDeployment } from "./deployment.mjs";

test("revocation deadline comes from the actual deployed Gateway TTL", () => {
  for (const [setting, expected] of [
    ["10s", 10000],
    ["250ms", 250],
    ["0", 0],
  ]) {
    const value = rows();
    const gateway = value.find(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === "edge-gateway",
    );
    gateway.Config.Env = [`ANTNEST_EDGE_RESOLVE_CACHE_TTL=${setting}`];
    assert.equal(
      inspectIdentityDeployment(value, "fixture").resolve_cache_ttl_ms,
      expected,
    );
  }
});
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
          : name === "agent-controller"
            ? ["ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL=2s"]
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

test("Identity deployment records the actual diagnostic Controller poll setting", () => {
  const key = "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL";
  for (const interval of ["2s", "100ms"]) {
    const value = rows();
    const controller = value.find(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === "agent-controller",
    );
    controller.Config.Env = [key + "=" + interval];
    const result = inspectIdentityDeployment(value, "fixture", interval);
    assert.equal(result.controller_identity_revocation_poll_interval, interval);
    for (const invalid of [
      [],
      [key + "=5s"],
      [key + "=" + interval, key + "=" + interval],
    ]) {
      controller.Config.Env = invalid;
      assert.throws(() =>
        inspectIdentityDeployment(value, "fixture", interval),
      );
    }
  }
});
