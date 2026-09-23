import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSameProcess, inspectProxy } from "./deployment.mjs";
const fixture = () => ({
  Id: "container",
  RestartCount: 0,
  Config: {
    Labels: {
      "com.docker.compose.project": "test",
      "com.docker.compose.service": "rpc-loss-proxy",
    },
  },
  State: { Running: true, StartedAt: "start", Health: { Status: "healthy" } },
  HostConfig: { PortBindings: {} },
});
test("fault proxy is private, healthy and owned; ACP remains the same process", () => {
  const before = fixture();
  inspectProxy([before], "test");
  assertSameProcess(before, structuredClone(before));
  for (const change of [
    (x) => (x.Id = "replacement"),
    (x) => x.RestartCount++,
    (x) => (x.State.StartedAt = "later"),
    (x) => (x.State.Running = false),
    (x) => (x.State.Health.Status = "unhealthy"),
  ]) {
    const after = fixture();
    change(after);
    assert.throws(() => assertSameProcess(before, after));
  }
  for (const change of [
    (x) => (x.Config.Labels["com.docker.compose.project"] = "retained"),
    (x) =>
      (x.HostConfig.PortBindings = { "8080/tcp": [{ HostIp: "127.0.0.1" }] }),
    (x) => (x.State.Health.Status = "unhealthy"),
  ]) {
    const row = fixture();
    change(row);
    assert.throws(() => inspectProxy([row], "test"));
  }
  assert.throws(() => inspectProxy([], "test"));
  assert.throws(() => inspectProxy([before, before], "test"));
});
