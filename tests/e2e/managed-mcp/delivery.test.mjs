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
  policy_revision: 2,
  complete: true,
  version: 1,
  project: "project",
  exit_code: 0,
  accepted: true,
  strict_trace: "failed",
  cleanup_completed: true,
  business: {
    status: "business_passed",
    version: 1,
    deleted: true,
    runs: 6,
    model_requests: 16,
    execution: {
      status: "passed",
      runs: 6,
      tool_calls: 10,
      managed_tool_calls: 6,
      builtin_tool_calls: 4,
      failed_tool_calls: 1,
      model_requests: 16,
    },
  },
  private_requests: 14,
  initializations: 3,
  business_requests: 11,
  lifecycle_traces: 3,
  tool_calls: 10,
  diagnostics: { accepted: true, strict_trace: "failed", exit_code: 2 },
});
const result = () => ({ complete: true, exit_code: 0 });
test("Managed delivery uses independent Run/Tool evidence and joined cleanup despite Trace warnings", () => {
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
  ["legacy completion policy", (f) => delete f.report.policy_revision],
  [
    "legacy Trace exit",
    (f) => {
      f.command.exit_code = 2;
      f.report.exit_code = 2;
    },
  ],
  ["incomplete business", (f) => (f.report.business.status = "pending")],
  ["Agent not deleted", (f) => (f.report.business.deleted = false)],
  ["incomplete request inventory", (f) => (f.report.private_requests = 13)],
  ["missing initialize", (f) => (f.report.initializations = 2)],
  ["missing request", (f) => (f.report.business_requests = 10)],
  ["missing tool", (f) => (f.report.tool_calls = 9)],
  ["missing raw business review", (f) => delete f.report.business.execution],
  [
    "failed raw business review",
    (f) => (f.report.business.execution.status = "failed"),
  ],
  ["missing persisted Run", (f) => (f.report.business.execution.runs = 5)],
  [
    "missing persisted Tool",
    (f) => (f.report.business.execution.tool_calls = 9),
  ],
  [
    "wrong managed Tool count",
    (f) => (f.report.business.execution.managed_tool_calls = 5),
  ],
  [
    "wrong builtin Tool count",
    (f) => (f.report.business.execution.builtin_tool_calls = 5),
  ],
  [
    "expected Tool failure missing",
    (f) => (f.report.business.execution.failed_tool_calls = 0),
  ],
  [
    "extra model request",
    (f) => (f.report.business.execution.model_requests = 17),
  ],
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

for (const [label, mutate] of [
  [
    "collector failure",
    (report) => {
      report.diagnostics = { accepted: false, exit_code: 1 };
    },
  ],
  [
    "strict failure",
    (report) => {
      report.strict_trace = "failed";
    },
  ],
  [
    "no lifecycle Trace",
    (report) => {
      report.lifecycle_traces = 0;
    },
  ],
  [
    "no Span tool count",
    (report) => {
      delete report.runtime_tool_calls;
    },
  ],
  [
    "diagnostic unavailable",
    (report) => {
      report.diagnostics = undefined;
      report.strict_trace = "not_collected";
    },
  ],
])
  test(`Managed ${label} stays auxiliary with independently completed business`, () => {
    const report = complete();
    mutate(report);
    implementation.assertManagedDelivery(result(), report, {
      version: 1,
      project: "project",
    });
  });
