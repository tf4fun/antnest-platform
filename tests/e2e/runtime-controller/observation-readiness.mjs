import assert from "node:assert/strict";

export function assertMonitorStatus(body, ready) {
  const { runtime_capacity, runtime_count, runtime_capacity_known, ...status } =
    body;
  assert(Number.isSafeInteger(runtime_capacity) && runtime_capacity >= 0);
  assert(Number.isSafeInteger(runtime_count) && runtime_count >= 0);
  assert.equal(typeof runtime_capacity_known, "boolean");
  assert.deepEqual(status, {
    status: ready ? "ready" : "not_ready",
    live: true,
    ready,
    database_ready: true,
    platform_ready: true,
    observation_ready: true,
    monitor_ready: ready,
    disk_quota_enforced: false,
  });
}
