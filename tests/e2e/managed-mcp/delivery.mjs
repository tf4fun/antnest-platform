import assert from "node:assert/strict";

export function managedLoopbackOrigin(rows, project, service, port) {
  assert.equal(rows.length, 1, "one owned Managed relay required");
  const [row] = rows;
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(row.Config.Labels["com.docker.compose.service"], service);
  assert.equal(row.State.Running, true);
  assert.equal(row.State.Health?.Status, "healthy");
  const ports = row.NetworkSettings.Ports[`${port}/tcp`];
  assert.equal(ports?.length, 1, "one Managed loopback binding required");
  assert.equal(ports[0].HostIp, "127.0.0.1");
  assert.match(ports[0].HostPort, /^[1-9][0-9]*$/u);
  assert(Number(ports[0].HostPort) <= 65535);
  return `http://127.0.0.1:${ports[0].HostPort}`;
}

// Exit 2 alone is never admission. This receipt is written only after all raw
// request checks and the actual connection/exporter cleanup have completed.
export function assertManagedDelivery(command, report, { version, project }) {
  assert.equal(command.complete, true);
  assert.equal(command.reason, undefined);
  assert.equal(command.signal, undefined);
  assert([0, 2].includes(command.exit_code));
  assert.equal(report?.complete, true);
  assert.equal(report.cleanup_completed, true);
  assert.equal(report.version, version);
  assert.equal(report.project, project);
  assert.equal(report.exit_code, command.exit_code);
  assert.equal(report.accepted, true);
  assert.equal(report.diagnostics.accepted, true);
  assert([0, 2].includes(report.diagnostics.exit_code));
  if (command.exit_code === 0) assert.equal(report.diagnostics.exit_code, 0);
  assert.equal(
    report.strict_trace,
    command.exit_code === 0 ? "passed" : "failed",
  );
  for (const [key, value] of Object.entries({
    private_requests: 14,
    initializations: 3,
    business_requests: 11,
    lifecycle_traces: 3,
    runtime_tool_calls: 10,
  }))
    assert.equal(report[key], value);
  for (const [key, value] of Object.entries({
    status: "business_passed",
    version,
    deleted: true,
    runs: 6,
    model_requests: 16,
  }))
    assert.equal(report.business[key], value);
}
