import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./delivery.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const row = () => ({
  Config: {
    Labels: {
      "com.docker.compose.project": "project",
      "com.docker.compose.service": "diagnostic-relay",
    },
  },
  State: { Running: true, Health: { Status: "healthy" } },
  NetworkSettings: {
    Ports: { "58081/tcp": [{ HostIp: "127.0.0.1", HostPort: "38081" }] },
  },
});
test("Managed relay endpoint is bound to the live owned service and a unique loopback port", () => {
  assert.equal(typeof implementation.managedLoopbackOrigin, "function");
  assert.equal(
    implementation.managedLoopbackOrigin(
      [row()],
      "project",
      "diagnostic-relay",
      58081,
    ),
    "http://127.0.0.1:38081",
  );
});
for (const [name, mutate] of [
  [
    "foreign project",
    (rows) => (rows[0].Config.Labels["com.docker.compose.project"] = "foreign"),
  ],
  [
    "wrong service",
    (rows) =>
      (rows[0].Config.Labels["com.docker.compose.service"] =
        "identity-service"),
  ],
  ["stopped relay", (rows) => (rows[0].State.Running = false)],
  ["unhealthy relay", (rows) => (rows[0].State.Health.Status = "unhealthy")],
  ["duplicate container", (rows) => rows.push(row())],
  [
    "wildcard address",
    (rows) =>
      (rows[0].NetworkSettings.Ports["58081/tcp"][0].HostIp = "0.0.0.0"),
  ],
  [
    "duplicate binding",
    (rows) =>
      rows[0].NetworkSettings.Ports["58081/tcp"].push({
        HostIp: "127.0.0.1",
        HostPort: "38082",
      }),
  ],
  [
    "invalid port",
    (rows) => (rows[0].NetworkSettings.Ports["58081/tcp"][0].HostPort = "0"),
  ],
])
  test(`Managed relay rejects ${name}`, () => {
    assert.equal(typeof implementation.managedLoopbackOrigin, "function");
    const rows = [row()];
    mutate(rows);
    assert.throws(() =>
      implementation.managedLoopbackOrigin(
        rows,
        "project",
        "diagnostic-relay",
        58081,
      ),
    );
  });

const complete = () => ({
  complete: true,
  version: 1,
  project: "project",
  exit_code: 2,
  accepted: true,
  strict_trace: "failed",
  cleanup_completed: true,
  business: {
    status: "business_passed",
    version: 1,
    deleted: true,
    runs: 6,
    model_requests: 16,
  },
  private_requests: 14,
  initializations: 3,
  business_requests: 11,
  lifecycle_traces: 3,
  runtime_tool_calls: 10,
  diagnostics: { accepted: true, strict_trace: "failed", exit_code: 2 },
});
const result = () => ({ complete: true, exit_code: 2 });
test("Managed delivery accepts reviewed warning only after business, trace inventory and joined cleanup", () => {
  assert.equal(typeof implementation.assertManagedDelivery, "function");
  implementation.assertManagedDelivery(result(), complete(), {
    version: 1,
    project: "project",
  });
});
for (const [name, mutate] of [
  ["missing completion", (f) => (f.report = undefined)],
  ["timeout", (f) => (f.command.reason = "timeout")],
  ["signal", (f) => (f.command.signal = "SIGTERM")],
  ["unexpected exit", (f) => (f.command.exit_code = 1)],
  ["wrong version", (f) => (f.report.version = 2)],
  ["wrong project", (f) => (f.report.project = "foreign")],
  ["cleanup failure", (f) => (f.report.cleanup_completed = false)],
  ["unowned diagnostic", (f) => (f.report.diagnostics.accepted = false)],
  ["incomplete request inventory", (f) => (f.report.private_requests = 13)],
  ["missing initialize", (f) => (f.report.initializations = 2)],
  ["missing tool", (f) => (f.report.runtime_tool_calls = 9)],
])
  test(`Managed delivery rejects ${name}`, () => {
    assert.equal(typeof implementation.assertManagedDelivery, "function");
    const f = { command: result(), report: complete() };
    mutate(f);
    assert.throws(() =>
      implementation.assertManagedDelivery(f.command, f.report, {
        version: 1,
        project: "project",
      }),
    );
  });
